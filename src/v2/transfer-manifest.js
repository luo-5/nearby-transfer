'use strict';

const crypto = require('crypto');
const {
  APP_ID,
  PROTOCOL_VERSION,
  MESSAGE_TYPES
} = require('./constants');
const { canonicalJson } = require('./canonical-json');

const TASK_ID_BYTES = 16;
const TASK_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const WINDOWS_RESERVED_NAME_PATTERN = /^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])$/i;
const WINDOWS_INVALID_COMPONENT_PATTERN = /[<>:"\\/|?*\u0000-\u001f\u007f]/;
const MAX_MANIFEST_ENTRIES = 10_000;
const MAX_TRANSFER_FILES = 8_192;
const MAX_RELATIVE_PATH_BYTES = 4_096;
const MAX_PATH_COMPONENT_BYTES = 255;
const MAX_FILE_SIZE_BYTES = 1_099_511_627_776; // 1 TiB
const MAX_TOTAL_SIZE_BYTES = 4_398_046_511_104; // 4 TiB
const CONFLICT_STRATEGY_AUTO_RENAME = 'auto-rename';
const PERSISTENCE_FORMAT_VERSION = 1;

function createTaskId() {
  return crypto.randomBytes(TASK_ID_BYTES).toString('base64url');
}

function assertValidTaskId(taskId) {
  if (typeof taskId !== 'string' || !TASK_ID_PATTERN.test(taskId)) {
    throw new TypeError('Transfer task ID must be a 16-byte base64url value');
  }

  let decoded;
  try {
    decoded = Buffer.from(taskId, 'base64url');
  } catch (_) {
    throw new TypeError('Transfer task ID must be a valid base64url value');
  }

  if (decoded.length !== TASK_ID_BYTES || decoded.toString('base64url') !== taskId) {
    throw new TypeError('Transfer task ID must be a canonical 16-byte base64url value');
  }
}

function assertValidRelativePath(relativePath) {
  if (typeof relativePath !== 'string' || relativePath.length === 0) {
    throw new TypeError('Transfer path must be a non-empty string');
  }
  assertWellFormedString(relativePath, 'Transfer path');

  if (Buffer.byteLength(relativePath, 'utf8') > MAX_RELATIVE_PATH_BYTES) {
    throw new RangeError('Transfer path exceeds the maximum UTF-8 length');
  }
  if (relativePath.startsWith('/') || relativePath.startsWith('\\') ||
      /^[A-Za-z]:/.test(relativePath) || relativePath.includes('\\')) {
    throw new TypeError('Transfer path must use a relative POSIX path');
  }

  const components = relativePath.split('/');
  for (const component of components) {
    if (component.length === 0 || component === '.' || component === '..') {
      throw new TypeError('Transfer path must not contain empty or traversal components');
    }
    if (Buffer.byteLength(component, 'utf8') > MAX_PATH_COMPONENT_BYTES) {
      throw new RangeError('Transfer path component exceeds the maximum UTF-8 length');
    }
    if (WINDOWS_INVALID_COMPONENT_PATTERN.test(component)) {
      throw new TypeError('Transfer path component contains a Windows-invalid character');
    }
    if (/[. ]$/.test(component)) {
      throw new TypeError('Transfer path component must not end in a period or space');
    }
    if (isWindowsReservedName(component)) {
      throw new TypeError('Transfer path component uses a Windows reserved device name');
    }
  }
}

function createTransferManifest(input) {
  assertPlainObject(input, 'Transfer manifest input');
  assertOnlyKeys(input, ['taskId', 'conflictStrategy', 'entries'], 'Transfer manifest input');

  const manifest = {
    app: APP_ID,
    protocolVersion: PROTOCOL_VERSION,
    type: MESSAGE_TYPES.TRANSFER_MANIFEST,
    taskId: input.taskId === undefined ? createTaskId() : input.taskId,
    conflictStrategy: input.conflictStrategy === undefined
      ? CONFLICT_STRATEGY_AUTO_RENAME
      : input.conflictStrategy,
    entries: input.entries
  };

  return normalizeTransferManifest(manifest);
}

function normalizeTransferManifest(manifest) {
  assertPlainObject(manifest, 'Transfer manifest');
  assertOnlyKeys(
    manifest,
    ['app', 'protocolVersion', 'type', 'taskId', 'conflictStrategy', 'entries', 'totalFiles', 'totalBytes'],
    'Transfer manifest'
  );

  if (manifest.app !== APP_ID || manifest.protocolVersion !== PROTOCOL_VERSION ||
      manifest.type !== MESSAGE_TYPES.TRANSFER_MANIFEST) {
    throw new TypeError('Transfer manifest protocol envelope is invalid');
  }
  assertValidTaskId(manifest.taskId);
  if (manifest.conflictStrategy !== CONFLICT_STRATEGY_AUTO_RENAME) {
    throw new TypeError('Transfer manifest conflict strategy must be auto-rename');
  }
  if (!Array.isArray(manifest.entries) || manifest.entries.length === 0 ||
      manifest.entries.length > MAX_MANIFEST_ENTRIES) {
    throw new RangeError('Transfer manifest must contain a bounded non-empty entry list');
  }

  const seenPaths = new Set();
  const seenWindowsPaths = new Set();
  const files = [];
  const directories = new Set();
  let totalBytes = 0;

  for (const entry of manifest.entries) {
    const normalizedEntry = normalizeEntry(entry);
    const windowsPath = windowsComparisonPath(normalizedEntry.path);
    if (seenPaths.has(normalizedEntry.path) || seenWindowsPaths.has(windowsPath)) {
      throw new TypeError('Transfer manifest contains duplicate or Windows-colliding paths');
    }
    seenPaths.add(normalizedEntry.path);
    seenWindowsPaths.add(windowsPath);

    if (normalizedEntry.kind === 'directory') {
      directories.add(normalizedEntry.path);
    } else {
      files.push(normalizedEntry);
      totalBytes = checkedAdd(totalBytes, normalizedEntry.size, 'Transfer manifest total size');
    }
  }

  if (files.length > MAX_TRANSFER_FILES) {
    throw new RangeError('Transfer manifest exceeds the maximum file count');
  }
  if (totalBytes > MAX_TOTAL_SIZE_BYTES) {
    throw new RangeError('Transfer manifest exceeds the maximum total size');
  }

  for (const directory of directories) {
    for (const parent of parentPaths(directory)) {
      if (!directories.has(parent)) {
        throw new TypeError(`Transfer directory parent is not declared: ${parent}`);
      }
    }
  }
  for (const file of files) {
    for (const parent of parentPaths(file.path)) {
      if (!directories.has(parent)) {
        throw new TypeError(`Transfer file parent directory is not declared: ${parent}`);
      }
    }
  }

  const normalizedEntries = manifest.entries
    .map(normalizeEntry)
    .sort((left, right) => compareCodeUnits(left.path, right.path));
  const normalized = {
    app: APP_ID,
    protocolVersion: PROTOCOL_VERSION,
    type: MESSAGE_TYPES.TRANSFER_MANIFEST,
    taskId: manifest.taskId,
    conflictStrategy: CONFLICT_STRATEGY_AUTO_RENAME,
    entries: normalizedEntries,
    totalFiles: files.length,
    totalBytes
  };

  if (Object.prototype.hasOwnProperty.call(manifest, 'totalFiles') && manifest.totalFiles !== normalized.totalFiles) {
    throw new TypeError('Transfer manifest totalFiles does not match its file entries');
  }
  if (Object.prototype.hasOwnProperty.call(manifest, 'totalBytes') && manifest.totalBytes !== normalized.totalBytes) {
    throw new TypeError('Transfer manifest totalBytes does not match its file entries');
  }

  return normalized;
}

function serializeTransferManifest(manifest) {
  return canonicalJson(normalizeTransferManifest(manifest));
}

function parsePersistedTransferManifest(serialized) {
  if (typeof serialized !== 'string' || serialized.length === 0) {
    throw new TypeError('Persisted transfer manifest must be non-empty JSON text');
  }

  let manifest;
  try {
    manifest = JSON.parse(serialized);
  } catch (_) {
    throw new TypeError('Persisted transfer manifest must be valid JSON text');
  }

  const normalized = normalizeTransferManifest(manifest);
  if (canonicalJson(normalized) !== serialized) {
    throw new TypeError('Persisted transfer manifest must use canonical JSON');
  }
  return normalized;
}

function createPersistedTransferManifest(input) {
  return serializeTransferManifest(createTransferManifest(input));
}

function normalizeEntry(entry) {
  assertPlainObject(entry, 'Transfer manifest entry');
  if (entry.kind === 'directory') {
    assertOnlyKeys(entry, ['kind', 'path'], 'Transfer directory entry');
    assertValidRelativePath(entry.path);
    return { kind: 'directory', path: entry.path };
  }
  if (entry.kind === 'file') {
    assertOnlyKeys(entry, ['kind', 'path', 'size', 'sha256'], 'Transfer file entry');
    assertValidRelativePath(entry.path);
    if (!Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > MAX_FILE_SIZE_BYTES) {
      throw new RangeError('Transfer file size must be a safe integer within the configured maximum');
    }
    if (typeof entry.sha256 !== 'string' || !SHA256_PATTERN.test(entry.sha256)) {
      throw new TypeError('Transfer file SHA-256 must be 64 lowercase hexadecimal characters');
    }
    return {
      kind: 'file',
      path: entry.path,
      size: entry.size,
      sha256: entry.sha256
    };
  }
  throw new TypeError('Transfer manifest entry kind must be file or directory');
}

function assertPlainObject(value, subject) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${subject} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${subject} must be a plain object`);
  }
}

function assertOnlyKeys(value, allowedKeys, subject) {
  for (const key of Object.keys(value)) {
    if (!allowedKeys.includes(key)) {
      throw new TypeError(`${subject} contains an unsupported field: ${key}`);
    }
  }
}

function isWindowsReservedName(component) {
  const baseName = component.split('.')[0].replace(/[. ]+$/u, '');
  return WINDOWS_RESERVED_NAME_PATTERN.test(baseName);
}

function parentPaths(relativePath) {
  const components = relativePath.split('/');
  const parents = [];
  for (let index = 1; index < components.length; index += 1) {
    parents.push(components.slice(0, index).join('/'));
  }
  return parents;
}

function windowsComparisonPath(relativePath) {
  return relativePath.split('/').map((component) => component.toUpperCase()).join('/');
}

function compareCodeUnits(left, right) {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function checkedAdd(left, right, subject) {
  if (left > Number.MAX_SAFE_INTEGER - right) {
    throw new RangeError(`${subject} exceeds JavaScript safe integer precision`);
  }
  return left + right;
}

function assertWellFormedString(value, subject) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) {
        throw new TypeError(`${subject} contains an unpaired surrogate`);
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new TypeError(`${subject} contains an unpaired surrogate`);
    }
  }
}

module.exports = {
  CONFLICT_STRATEGY_AUTO_RENAME,
  MAX_FILE_SIZE_BYTES,
  MAX_MANIFEST_ENTRIES,
  MAX_RELATIVE_PATH_BYTES,
  MAX_TOTAL_SIZE_BYTES,
  MAX_TRANSFER_FILES,
  PERSISTENCE_FORMAT_VERSION,
  assertValidRelativePath,
  assertValidTaskId,
  createPersistedTransferManifest,
  createTaskId,
  createTransferManifest,
  normalizeTransferManifest,
  parsePersistedTransferManifest,
  serializeTransferManifest
};
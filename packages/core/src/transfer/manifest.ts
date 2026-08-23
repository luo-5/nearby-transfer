/**
 * Transfer manifest: creation, normalization, serialization, and validation.
 * Ported from src/v2/transfer-manifest.js.
 *
 * A manifest describes the files and directories in one transfer task. It is
 * canonical-JSON serialized for signing and persistence. Path validation
 * enforces relative POSIX paths, rejects traversal/symlink-unsafe components,
 * and blocks Windows reserved names so manifests are portable across platforms.
 */

import crypto from 'node:crypto';
import { Buffer } from 'node:buffer';
import { APP_ID, PROTOCOL_VERSION, MESSAGE_TYPES } from '../constants.js';
import { canonicalJson, type CanonicalValue } from '../canonical-json.js';
import { assertWellFormedString, assertValidTaskId, assertValidRelativePath, TASK_ID_BYTES } from './manifest-validation.js';
export { assertValidTaskId, assertValidRelativePath } from './manifest-validation.js';

export const SHA256_PATTERN = /^[a-f0-9]{64}$/;
export const MAX_MANIFEST_ENTRIES = 10_000;
export const MAX_TRANSFER_FILES = 8_192;
export const MAX_FILE_SIZE_BYTES = 1_099_511_627_776; // 1 TiB
export const MAX_TOTAL_SIZE_BYTES = 4_398_046_511_104; // 4 TiB
export const CONFLICT_STRATEGY_AUTO_RENAME = 'auto-rename';
export const PERSISTENCE_FORMAT_VERSION = 1;

// Re-export constants from manifest-validation for a single export surface.
export { TASK_ID_BYTES, TASK_ID_PATTERN, MAX_RELATIVE_PATH_BYTES, MAX_PATH_COMPONENT_BYTES } from './manifest-validation.js';

const WINDOWS_RESERVED_NAME_PATTERN = /^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])$/i;
const WINDOWS_INVALID_COMPONENT_PATTERN = /[<>:"\\/|?*\u0000-\u001f\u007f]/;

export interface ManifestDirectoryEntry {
  kind: 'directory';
  path: string;
}

export interface ManifestFileEntry {
  kind: 'file';
  path: string;
  size: number;
  sha256: string;
}

export type ManifestEntry = ManifestDirectoryEntry | ManifestFileEntry;

export interface TransferManifest {
  app: string;
  protocolVersion: number;
  type: string;
  taskId: string;
  conflictStrategy: string;
  entries: ManifestEntry[];
  totalFiles: number;
  totalBytes: number;
}

export interface CreateManifestInput {
  taskId?: string;
  conflictStrategy?: string;
  entries: ManifestEntry[];
}

export function createTaskId(): string {
  return crypto.randomBytes(TASK_ID_BYTES).toString('base64url');
}

export function createTransferManifest(input: CreateManifestInput): TransferManifest {
  assertPlainObject(input, 'Transfer manifest input');
  assertOnlyKeys(input as unknown as Record<string, unknown>, ['taskId', 'conflictStrategy', 'entries'], 'Transfer manifest input');

  const manifest: Record<string, unknown> = {
    app: APP_ID,
    protocolVersion: PROTOCOL_VERSION,
    type: MESSAGE_TYPES.TRANSFER_MANIFEST,
    taskId: input.taskId === undefined ? createTaskId() : input.taskId,
    conflictStrategy: input.conflictStrategy === undefined ? CONFLICT_STRATEGY_AUTO_RENAME : input.conflictStrategy,
    entries: input.entries,
  };

  return normalizeTransferManifest(manifest as unknown as TransferManifest);
}

export function normalizeTransferManifest(manifest: unknown): TransferManifest {
  assertPlainObject(manifest, 'Transfer manifest');
  const m = manifest as Record<string, unknown>;
  assertOnlyKeys(m, ['app', 'protocolVersion', 'type', 'taskId', 'conflictStrategy', 'entries', 'totalFiles', 'totalBytes'], 'Transfer manifest');

  if (m.app !== APP_ID || m.protocolVersion !== PROTOCOL_VERSION || m.type !== MESSAGE_TYPES.TRANSFER_MANIFEST) {
    throw new TypeError('Transfer manifest protocol envelope is invalid');
  }
  assertValidTaskId(m.taskId as string);
  if (m.conflictStrategy !== CONFLICT_STRATEGY_AUTO_RENAME) {
    throw new TypeError('Transfer manifest conflict strategy must be auto-rename');
  }
  if (!Array.isArray(m.entries) || m.entries.length === 0 || m.entries.length > MAX_MANIFEST_ENTRIES) {
    throw new RangeError('Transfer manifest must contain a bounded non-empty entry list');
  }

  const seenPaths = new Set<string>();
  const seenWindowsPaths = new Set<string>();
  const files: ManifestFileEntry[] = [];
  const directories = new Set<string>();
  let totalBytes = 0;

  for (const entry of m.entries) {
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

  const normalizedEntries = (m.entries as ManifestEntry[]).map(normalizeEntry).sort((left, right) => compareCodeUnits(left.path, right.path));
  const normalized: TransferManifest = {
    app: APP_ID,
    protocolVersion: PROTOCOL_VERSION,
    type: MESSAGE_TYPES.TRANSFER_MANIFEST,
    taskId: m.taskId as string,
    conflictStrategy: CONFLICT_STRATEGY_AUTO_RENAME,
    entries: normalizedEntries,
    totalFiles: files.length,
    totalBytes,
  };

  if (Object.prototype.hasOwnProperty.call(m, 'totalFiles') && m.totalFiles !== normalized.totalFiles) {
    throw new TypeError('Transfer manifest totalFiles does not match its file entries');
  }
  if (Object.prototype.hasOwnProperty.call(m, 'totalBytes') && m.totalBytes !== normalized.totalBytes) {
    throw new TypeError('Transfer manifest totalBytes does not match its file entries');
  }

  return normalized;
}

export function serializeTransferManifest(manifest: unknown): string {
  return canonicalJson(normalizeTransferManifest(manifest) as unknown as CanonicalValue);
}

export function parsePersistedTransferManifest(serialized: string): TransferManifest {
  if (typeof serialized !== 'string' || serialized.length === 0) {
    throw new TypeError('Persisted transfer manifest must be non-empty JSON text');
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(serialized);
  } catch {
    throw new TypeError('Persisted transfer manifest must be valid JSON text');
  }
  const normalized = normalizeTransferManifest(manifest);
  if (canonicalJson(normalized as unknown as CanonicalValue) !== serialized) {
    throw new TypeError('Persisted transfer manifest must use canonical JSON');
  }
  return normalized;
}

export function createPersistedTransferManifest(input: CreateManifestInput): string {
  return serializeTransferManifest(createTransferManifest(input));
}

function normalizeEntry(entry: unknown): ManifestEntry {
  assertPlainObject(entry, 'Transfer manifest entry');
  const e = entry as Record<string, unknown>;
  if (e.kind === 'directory') {
    assertOnlyKeys(e, ['kind', 'path'], 'Transfer directory entry');
    assertValidRelativePath(e.path as string);
    return { kind: 'directory', path: e.path as string };
  }
  if (e.kind === 'file') {
    assertOnlyKeys(e, ['kind', 'path', 'size', 'sha256'], 'Transfer file entry');
    assertValidRelativePath(e.path as string);
    if (!Number.isSafeInteger(e.size) || (e.size as number) < 0 || (e.size as number) > MAX_FILE_SIZE_BYTES) {
      throw new RangeError('Transfer file size must be a safe integer within the configured maximum');
    }
    if (typeof e.sha256 !== 'string' || !SHA256_PATTERN.test(e.sha256)) {
      throw new TypeError('Transfer file SHA-256 must be 64 lowercase hexadecimal characters');
    }
    return { kind: 'file', path: e.path as string, size: e.size as number, sha256: e.sha256 };
  }
  throw new TypeError('Transfer manifest entry kind must be file or directory');
}

function isWindowsReservedName(component: string): boolean {
  const baseName = component.split('.')[0]!.replace(/[. ]+$/u, '');
  return WINDOWS_RESERVED_NAME_PATTERN.test(baseName);
}

function parentPaths(relativePath: string): string[] {
  const components = relativePath.split('/');
  const parents: string[] = [];
  for (let index = 1; index < components.length; index += 1) {
    parents.push(components.slice(0, index).join('/'));
  }
  return parents;
}

function windowsComparisonPath(relativePath: string): string {
  return relativePath.split('/').map((component) => component.toUpperCase()).join('/');
}

function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function checkedAdd(left: number, right: number, subject: string): number {
  if (left > Number.MAX_SAFE_INTEGER - right) {
    throw new RangeError(`${subject} exceeds JavaScript safe integer precision`);
  }
  return left + right;
}

function assertPlainObject(value: unknown, subject: string): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${subject} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${subject} must be an object`);
  }
}

function assertOnlyKeys(value: Record<string, unknown>, allowedKeys: string[], subject: string): void {
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new TypeError(`${subject} contains an unsupported field: ${key}`);
    }
  }
}

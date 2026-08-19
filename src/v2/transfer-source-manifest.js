'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  CONFLICT_STRATEGY_AUTO_RENAME,
  MAX_MANIFEST_ENTRIES,
  assertValidRelativePath,
  createTransferManifest
} = require('./transfer-manifest');

const MAX_SOURCE_ROOTS = 1_024;

async function buildTransferSourceManifest(sourcePaths, options = {}) {
  if (!Array.isArray(sourcePaths) || sourcePaths.length === 0 || sourcePaths.length > MAX_SOURCE_ROOTS) {
    throw new RangeError('Transfer sources must be a bounded non-empty array');
  }
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('Transfer source options must be an object');
  }

  const roots = [];
  const seenAbsolutePaths = new Set();
  const seenBundlePaths = new Set();
  for (const sourcePath of sourcePaths) {
    if (typeof sourcePath !== 'string' || sourcePath.length === 0) {
      throw new TypeError('Transfer source path must be a non-empty string');
    }
    const absolutePath = path.resolve(sourcePath);
    const absoluteKey = windowsComparisonPath(absolutePath);
    if (seenAbsolutePaths.has(absoluteKey)) {
      throw new TypeError('Transfer source paths must be unique');
    }
    seenAbsolutePaths.add(absoluteKey);

    const bundlePath = path.basename(absolutePath);
    assertValidRelativePath(bundlePath);
    const bundleKey = windowsComparisonPath(bundlePath);
    if (seenBundlePaths.has(bundleKey)) {
      throw new TypeError('Transfer source names collide on case-insensitive filesystems');
    }
    seenBundlePaths.add(bundleKey);
    roots.push({ absolutePath, bundlePath });
  }

  roots.sort((left, right) => compareCodeUnits(left.bundlePath, right.bundlePath));
  const entries = [];
  const files = [];

  for (const root of roots) {
    await collectSource(root.absolutePath, root.bundlePath, entries, files);
  }

  const manifest = createTransferManifest({
    taskId: options.taskId,
    conflictStrategy: options.conflictStrategy || CONFLICT_STRATEGY_AUTO_RENAME,
    entries
  });

  const fileByPath = new Map(files.map((file) => [file.path, file]));
  return Object.freeze({
    manifest,
    files: Object.freeze(manifest.entries
      .filter((entry) => entry.kind === 'file')
      .map((entry) => Object.freeze(fileByPath.get(entry.path))))
  });
}

async function collectSource(absolutePath, relativePath, entries, files) {
  ensureEntryCapacity(entries);
  const initial = await fs.promises.lstat(absolutePath);
  if (initial.isSymbolicLink()) {
    throw new TypeError(`Symbolic links are not supported transfer sources: ${relativePath}`);
  }
  if (initial.isDirectory()) {
    entries.push({ kind: 'directory', path: relativePath });
    const children = await fs.promises.readdir(absolutePath, { withFileTypes: true });
    children.sort((left, right) => compareCodeUnits(left.name, right.name));
    for (const child of children) {
      const childRelativePath = `${relativePath}/${child.name}`;
      assertValidRelativePath(childRelativePath);
      await collectSource(path.join(absolutePath, child.name), childRelativePath, entries, files);
    }
    const final = await fs.promises.lstat(absolutePath);
    assertSameDirectorySnapshot(initial, final, relativePath);
    return;
  }
  if (!initial.isFile()) {
    throw new TypeError(`Only regular files and directories can be transferred: ${relativePath}`);
  }

  const snapshot = await hashStableFile(absolutePath, initial, relativePath);
  entries.push({ kind: 'file', path: relativePath, size: snapshot.size, sha256: snapshot.sha256 });
  files.push({ path: relativePath, sourcePath: absolutePath, size: snapshot.size, sha256: snapshot.sha256 });
}

async function hashStableFile(absolutePath, initial, relativePath) {
  const handle = await fs.promises.open(absolutePath, 'r');
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || !sameFileIdentity(initial, opened)) {
      throw new Error(`Transfer source changed while preparing manifest: ${relativePath}`);
    }

    const hash = crypto.createHash('sha256');
    const stream = handle.createReadStream({ autoClose: false, start: 0 });
    for await (const chunk of stream) {
      hash.update(chunk);
    }

    const final = await handle.stat();
    if (!sameFileSnapshot(opened, final)) {
      throw new Error(`Transfer source changed while hashing: ${relativePath}`);
    }
    return { size: final.size, sha256: hash.digest('hex') };
  } finally {
    await handle.close();
  }
}

function sameFileIdentity(left, right) {
  if (left.size !== right.size || left.mtimeMs !== right.mtimeMs) return false;
  if (Number.isInteger(left.dev) && Number.isInteger(right.dev) && left.dev !== 0 && right.dev !== 0 && left.dev !== right.dev) return false;
  if (Number.isInteger(left.ino) && Number.isInteger(right.ino) && left.ino !== 0 && right.ino !== 0 && left.ino !== right.ino) return false;
  return true;
}

function sameFileSnapshot(left, right) {
  return sameFileIdentity(left, right) && left.ctimeMs === right.ctimeMs;
}

function assertSameDirectorySnapshot(initial, final, relativePath) {
  if (!final.isDirectory() || !sameFileIdentity(initial, final)) {
    throw new Error(`Transfer directory changed while preparing manifest: ${relativePath}`);
  }
}

function ensureEntryCapacity(entries) {
  if (entries.length >= MAX_MANIFEST_ENTRIES) {
    throw new RangeError('Transfer sources exceed the maximum manifest entry count');
  }
}

function windowsComparisonPath(value) {
  return value.toUpperCase();
}

function compareCodeUnits(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

module.exports = {
  MAX_SOURCE_ROOTS,
  buildTransferSourceManifest
};

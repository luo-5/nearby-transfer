/**
 * Build a transfer manifest from local filesystem source paths.
 * Ported from src/v2/transfer-source-manifest.js.
 *
 * Walks the source paths (files or directories), hashes each file with SHA-256,
 * and constructs a normalized transfer manifest with matching entries. Detects
 * TOCTOU changes by comparing file identity (dev/ino/size/mtime) before and
 * after hashing.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Buffer } from 'node:buffer';
import {
  CONFLICT_STRATEGY_AUTO_RENAME,
  MAX_MANIFEST_ENTRIES,
  assertValidRelativePath,
  createTransferManifest,
  type ManifestEntry,
  type TransferManifest,
} from './manifest.js';

export const MAX_SOURCE_ROOTS = 1_024;

export interface SourceFile {
  path: string;
  sourcePath: string;
  size: number;
  sha256: string;
}

export interface SourceManifest {
  manifest: TransferManifest;
  files: readonly SourceFile[];
}

export async function buildTransferSourceManifest(
  sourcePaths: string[],
  options: { taskId?: string; conflictStrategy?: string } = {},
): Promise<SourceManifest> {
  if (!Array.isArray(sourcePaths) || sourcePaths.length === 0 || sourcePaths.length > MAX_SOURCE_ROOTS) {
    throw new RangeError('Transfer sources must be a bounded non-empty array');
  }
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('Transfer source options must be an object');
  }

  const roots: Array<{ absolutePath: string; bundlePath: string }> = [];
  const seenAbsolutePaths = new Set<string>();
  const seenBundlePaths = new Set<string>();
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
  const entries: ManifestEntry[] = [];
  const files: SourceFile[] = [];

  for (const root of roots) {
    await collectSource(root.absolutePath, root.bundlePath, entries, files);
  }

  const manifestInput: { entries: ManifestEntry[]; taskId?: string; conflictStrategy?: string } = {
    conflictStrategy: options.conflictStrategy || CONFLICT_STRATEGY_AUTO_RENAME,
    entries,
  };
  if (options.taskId !== undefined) manifestInput.taskId = options.taskId;
  const manifest = createTransferManifest(manifestInput);

  const fileByPath = new Map(files.map((file) => [file.path, file]));
  return Object.freeze({
    manifest,
    files: Object.freeze(
      manifest.entries
        .filter((entry) => entry.kind === 'file')
        .map((entry) => Object.freeze(fileByPath.get(entry.path)!)),
    ),
  });
}

async function collectSource(
  absolutePath: string,
  relativePath: string,
  entries: ManifestEntry[],
  files: SourceFile[],
): Promise<void> {
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

interface FileSnapshot {
  size: number;
  sha256: string;
}

async function hashStableFile(
  absolutePath: string,
  initial: fs.Stats,
  relativePath: string,
): Promise<FileSnapshot> {
  const handle = await fs.promises.open(absolutePath, 'r');
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || !sameFileIdentity(initial, opened)) {
      throw new Error(`Transfer source changed while preparing manifest: ${relativePath}`);
    }

    const hash = crypto.createHash('sha256');
    const stream = handle.createReadStream({ autoClose: false, start: 0 });
    for await (const chunk of stream) {
      hash.update(chunk as Buffer);
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

function sameFileIdentity(left: fs.Stats, right: fs.Stats): boolean {
  if (left.size !== right.size || left.mtimeMs !== right.mtimeMs) return false;
  if (Number.isInteger(left.dev) && Number.isInteger(right.dev) && left.dev !== 0 && right.dev !== 0 && left.dev !== right.dev) return false;
  if (Number.isInteger(left.ino) && Number.isInteger(right.ino) && left.ino !== 0 && right.ino !== 0 && left.ino !== right.ino) return false;
  return true;
}

function sameFileSnapshot(left: fs.Stats, right: fs.Stats): boolean {
  return sameFileIdentity(left, right) && left.ctimeMs === right.ctimeMs;
}

function assertSameDirectorySnapshot(initial: fs.Stats, final: fs.Stats, relativePath: string): void {
  if (!final.isDirectory() || !sameFileIdentity(initial, final)) {
    throw new Error(`Transfer directory changed while preparing manifest: ${relativePath}`);
  }
}

function ensureEntryCapacity(entries: ManifestEntry[]): void {
  if (entries.length >= MAX_MANIFEST_ENTRIES) {
    throw new RangeError('Transfer sources exceed the maximum manifest entry count');
  }
}

function windowsComparisonPath(value: string): string {
  return value.toUpperCase();
}

function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

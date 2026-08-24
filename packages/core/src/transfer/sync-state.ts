/**
 * Incremental sync state — quick hash (first 1 MiB) + full hash comparison
 * to detect which files changed since the last sync, avoiding redundant
 * retransmission of unchanged files.
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

export interface ScanResult {
  relativePath: string;
  absolutePath: string;
  size: number;
}

export interface FileSyncState {
  path: string;
  size: number;
  mtimeMs: number;
  quickHash: string;
  fullHash: string;
}

export interface SyncState {
  deviceId: string;
  lastSyncAt: number;
  files: Map<string, FileSyncState>;
}

const DEFAULT_QUICK_HASH_BYTES = 1024 * 1024;

export async function computeQuickHash(filePath: string, maxBytes: number = DEFAULT_QUICK_HASH_BYTES): Promise<string> {
  const hash = createHash('sha256');
  const stream = createReadStream(filePath, { start: 0, end: maxBytes - 1 });
  for await (const chunk of stream) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

export async function computeFullHash(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  const stream = createReadStream(filePath);
  for await (const chunk of stream) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

export async function planIncrementalSync(
  files: readonly ScanResult[],
  lastState: SyncState | null,
): Promise<{ toSend: ScanResult[]; unchanged: string[] }> {
  if (!lastState || lastState.files.size === 0) {
    return { toSend: [...files], unchanged: [] };
  }

  const toSend: ScanResult[] = [];
  const unchanged: string[] = [];

  for (const file of files) {
    const prev = lastState.files.get(file.relativePath);
    if (!prev || prev.size !== file.size) {
      toSend.push(file);
      continue;
    }
    const quick = await computeQuickHash(file.absolutePath);
    if (quick !== prev.quickHash) {
      toSend.push(file);
    } else {
      unchanged.push(file.relativePath);
    }
  }

  return { toSend, unchanged };
}

export async function buildSyncState(
  deviceId: string,
  files: readonly ScanResult[],
): Promise<SyncState> {
  const fileStates = new Map<string, FileSyncState>();
  for (const file of files) {
    const quickHash = await computeQuickHash(file.absolutePath);
    const fullHash = await computeFullHash(file.absolutePath);
    fileStates.set(file.relativePath, {
      path: file.relativePath,
      size: file.size,
      mtimeMs: 0,
      quickHash,
      fullHash,
    });
  }
  return {
    deviceId,
    lastSyncAt: Date.now(),
    files: fileStates,
  };
}

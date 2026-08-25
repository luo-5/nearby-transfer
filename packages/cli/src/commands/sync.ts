/**
 * `nearby-transfer sync --dir <directory> --to <device-id|ip>` — recursively
 * sync a directory to a trusted device using the v2 encrypted transfer.
 *
 * Scans the directory, builds a manifest with relative paths preserving
 * subdirectory structure, and runs createDesktopTransferExecutor.
 */

import { parseArgs } from 'node:util';
import { readdirSync, statSync, existsSync, createReadStream } from 'node:fs';
import { resolve, relative, sep, join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  V2Discovery,
  createTransferManifest,
  createDesktopTransferExecutor,
  JOB_DIRECTION,
  JOB_STATUS,
  type DiscoveredPeerEntry,
} from '@luo-5/core';
import { loadOrCreateDevice, parseCommonOptions } from '../device.js';

export interface ScanResult {
  relativePath: string;
  absolutePath: string;
  size: number;
  mtimeMs: number;
}

export function scanDirectory(root: string): ScanResult[] {
  const results: ScanResult[] = [];
  function walk(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        const stat = statSync(fullPath);
        results.push({
          relativePath: relative(root, fullPath).split(sep).join('/'),
          absolutePath: fullPath,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
        });
      }
    }
  }
  walk(root);
  return results;
}

async function computeFileHash(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  const stream = createReadStream(filePath);
  for await (const chunk of stream) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

export async function syncCommand(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      dir: { type: 'string' },
      to: { type: 'string' },
      'data-dir': { type: 'string' },
      timeout: { type: 'string' },
    },
    allowPositionals: true,
  });

  if (!values.dir) {
    process.stderr.write('Error: --dir <directory> is required\n');
    process.exit(1);
  }
  if (!values.to) {
    process.stderr.write('Error: --to <device-id|ip> is required\n');
    process.exit(1);
  }

  const opts = parseCommonOptions(args);
  const device = loadOrCreateDevice(opts.dataDir);

  const rootDir = resolve(values.dir);
  if (!existsSync(rootDir) || !statSync(rootDir).isDirectory()) {
    process.stderr.write(`Error: directory not found: ${values.dir}\n`);
    process.exit(1);
  }

  process.stdout.write(`Scanning ${rootDir}...\n`);
  const scanResults = scanDirectory(rootDir);

  if (scanResults.length === 0) {
    process.stderr.write('Error: directory is empty\n');
    process.exit(1);
  }

  process.stdout.write(`Found ${scanResults.length} file(s)\n`);

  // Build manifest entries with relative paths
  process.stdout.write('Computing hashes...\n');
  const entries = [];
  const sources = [];
  for (const file of scanResults) {
    const sha256 = await computeFileHash(file.absolutePath);
    entries.push({ kind: 'file' as const, path: file.relativePath, size: file.size, sha256 });
    sources.push({ path: file.relativePath, sourcePath: file.absolutePath, size: file.size, sha256 });
  }

  const manifest = createTransferManifest({ entries });
  const totalBytes = scanResults.reduce((sum, f) => sum + f.size, 0);
  process.stdout.write(`  Total: ${manifest.totalFiles} file(s), ${formatBytes(totalBytes)}\n\n`);

  // Discover the target device
  const discovery = new V2Discovery({
    device,
    port: 0,
    capabilities: ['pairing', 'transfer'],
  });

  let targetPeer: DiscoveredPeerEntry | null = null;
  discovery.on('peer', (peer: DiscoveredPeerEntry) => {
    if (peer.deviceId === values.to || peer.host === values.to) {
      targetPeer = peer;
    }
  });

  discovery.start();
  const timeout = opts.timeout ?? 15000;
  const deadline = Date.now() + timeout;
  while (!targetPeer && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
  }
  discovery.stop();

  if (!targetPeer) {
    process.stderr.write(`Device not found: ${values.to}\n`);
    process.exit(1);
  }

  const peer = targetPeer as DiscoveredPeerEntry;
  process.stdout.write(`Connected to: ${peer.deviceName} (${peer.deviceId})\n\n`);

  const now = Date.now();
  const job = {
    taskId: manifest.taskId,
    peerDeviceId: peer.deviceId,
    direction: JOB_DIRECTION.OUTGOING,
    status: JOB_STATUS.TRANSFERRING,
    manifest,
    sources,
    createdAt: now,
    updatedAt: now,
    errorMessage: null,
    diagnosticCode: null,
    files: [],
    outgoingCheckpoint: null,
    localDeviceId: device.deviceId,
    signingPrivateKey: device.signingPrivateKey,
    remoteSigningPublicKey: peer.signingPublicKey,
    remoteEncryptionPublicKey: peer.encryptionPublicKey,
    peer: { host: peer.host, port: peer.port },
  };

  const controller = new AbortController();

  process.stdout.write('Starting encrypted sync...\n');
  try {
    const executor = await createDesktopTransferExecutor({
      job: job as never,
      checkpoint: null,
      signal: controller.signal,
      commitRemoteCheckpoint: (() => job) as never,
    });
    await executor.done;
    process.stdout.write('\nSync completed successfully!\n');
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Sync failed: ${msg}\n`);
    process.exit(1);
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

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
  type DiscoveredPeerEntry,
} from '@luo-5/core';
import { loadOrCreateDevice, parseCommonOptions, requireTrustedPeerIdentity } from '../device.js';
import { commitCliCheckpoint, createCliTransferContext } from '../transfer-context.js';

export interface ScanResult {
  kind: 'directory' | 'file';
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
        const stat = statSync(fullPath);
        results.push({
          kind: 'directory',
          relativePath: relative(root, fullPath).split(sep).join('/'),
          absolutePath: fullPath,
          size: 0,
          mtimeMs: stat.mtimeMs,
        });
        walk(fullPath);
      } else if (entry.isFile()) {
        const stat = statSync(fullPath);
        results.push({
          kind: 'file',
          relativePath: relative(root, fullPath).split(sep).join('/'),
          absolutePath: fullPath,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
        });
      } else {
        throw new TypeError(`Unsupported directory entry (links and special files are not synced): ${relative(root, fullPath)}`);
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

  // Discover the target device
  const discovery = new V2Discovery({
    device,
    port: 0,
    announce: false,
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
  await requireTrustedPeerIdentity(peer, opts.dataDir);
  process.stdout.write(`Connected to: ${peer.deviceName} (${peer.deviceId})\n\n`);

  process.stdout.write(`Scanning ${rootDir}...\n`);
  const scanResults = scanDirectory(rootDir);
  if (scanResults.length === 0) {
    process.stderr.write('Error: directory is empty\n');
    process.exit(1);
  }
  const fileResults = scanResults.filter((entry) => entry.kind === 'file');
  const directoryResults = scanResults.filter((entry) => entry.kind === 'directory');
  process.stdout.write(`Found ${fileResults.length} file(s) and ${directoryResults.length} director${directoryResults.length === 1 ? 'y' : 'ies'}\n`);

  process.stdout.write('Computing hashes...\n');
  const entries = [];
  const sources = [];
  for (const directory of directoryResults) {
    entries.push({ kind: 'directory' as const, path: directory.relativePath });
  }
  for (const file of fileResults) {
    const sha256 = await computeFileHash(file.absolutePath);
    entries.push({ kind: 'file' as const, path: file.relativePath, size: file.size, sha256 });
    sources.push({ path: file.relativePath, sourcePath: file.absolutePath, size: file.size, sha256 });
  }
  const manifest = createTransferManifest({ entries });
  const totalBytes = fileResults.reduce((sum, f) => sum + f.size, 0);
  process.stdout.write(`  Total: ${manifest.totalFiles} file(s), ${formatBytes(totalBytes)}\n\n`);

  const { job, trustedPeer } = createCliTransferContext({ device, peer, manifest, sources });

  const controller = new AbortController();
  let interrupted = false;
  const onSignal = () => {
    if (interrupted) return;
    interrupted = true;
    process.stderr.write('\nStopping sync...\n');
    controller.abort(new Error('Sync interrupted by user'));
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  const checkpoint = {
    files: sources.map((f) => ({ path: f.path, size: f.size, committedOffset: 0, completed: false })),
    nextSequence: 0,
    totalTransferred: 0,
  };

  process.stdout.write('Starting encrypted sync...\n');
  try {
    const executor = await createDesktopTransferExecutor({
      job: job as never,
      checkpoint: checkpoint as never,
      signal: controller.signal,
      commitRemoteCheckpoint: commitCliCheckpoint,
      localDevice: {
        deviceId: device.deviceId,
        signingPrivateKey: device.signingPrivateKey,
      },
      trustedPeerStore: {
        getTrustedPeer: () => trustedPeer,
      },
      lanService: {
        listPeers: () => [peer as never],
      },
    });
    await executor.done;
    process.stdout.write('\nSync completed successfully!\n');
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${interrupted ? 'Sync interrupted' : 'Sync failed'}: ${msg}\n`);
    process.exitCode = interrupted ? 130 : 1;
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/**
 * `nearby-transfer send <file...> --to <device-id|ip>` — send files to a
 * trusted device using the full v2 encrypted transfer protocol.
 *
 * Discovers the target peer via UDP multicast, builds a source manifest,
 * and runs the core's createDesktopTransferExecutor to bootstrap the
 * transfer, derive the session key, and stream AES-256-GCM encrypted chunks.
 */

import { parseArgs } from 'node:util';
import { existsSync, statSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import {
  V2Discovery,
  buildTransferSourceManifest,
  createDesktopTransferExecutor,
  JOB_DIRECTION,
  JOB_STATUS,
  type DiscoveredPeerEntry,
} from '@luo-5/core';
import { loadOrCreateDevice, parseCommonOptions } from '../device.js';

export async function sendCommand(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      to: { type: 'string' },
      'data-dir': { type: 'string' },
      timeout: { type: 'string' },
    },
    allowPositionals: true,
  });

  if (positionals.length === 0) {
    process.stderr.write('Error: at least one file path is required\n');
    process.exit(1);
  }
  if (!values.to) {
    process.stderr.write('Error: --to <device-id|ip> is required\n');
    process.exit(1);
  }

  const opts = parseCommonOptions(args);
  const device = loadOrCreateDevice(opts.dataDir);

  // Validate files
  const filePaths = positionals.map((p) => {
    const abs = resolve(p);
    if (!existsSync(abs)) throw new Error(`File not found: ${p}`);
    const stat = statSync(abs);
    if (stat.isDirectory()) throw new Error(`Directories not supported yet: ${p} (use individual files)`);
    return abs;
  });

  process.stdout.write(`Sending ${filePaths.length} file(s) to ${values.to}...\n`);

  // Build the source manifest (scans files, computes SHA-256)
  process.stdout.write('Building manifest...\n');
  const sourceManifest = await buildTransferSourceManifest(filePaths);
  const manifest = sourceManifest.manifest;

  for (const file of sourceManifest.files) {
    process.stdout.write(`  ${file.path} (${formatBytes(file.size)})\n`);
  }
  process.stdout.write(`  Total: ${manifest.totalFiles} file(s), ${formatBytes(manifest.totalBytes)}\n\n`);

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
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  discovery.stop();

  if (!targetPeer) {
    process.stderr.write(`Device not found: ${values.to}\n`);
    process.exit(1);
  }

  const peer = targetPeer as DiscoveredPeerEntry;
  process.stdout.write(`Connected to: ${peer.deviceName} (${peer.deviceId})\n`);
  process.stdout.write(`  Address: ${peer.host}:${peer.port}\n\n`);

  // Construct the transfer job
  const now = Date.now();
  const job = {
    taskId: manifest.taskId,
    peerDeviceId: peer.deviceId,
    direction: JOB_DIRECTION.OUTGOING,
    status: JOB_STATUS.TRANSFERRING,
    manifest,
    sources: sourceManifest.files.map((f) => ({ path: f.path, sourcePath: f.sourcePath, size: f.size, sha256: f.sha256 })),
    createdAt: now,
    updatedAt: now,
    // Extra fields the executor accesses via type casting:
    localDeviceId: device.deviceId,
    signingPrivateKey: device.signingPrivateKey,
    remoteSigningPublicKey: peer.signingPublicKey,
    remoteEncryptionPublicKey: peer.encryptionPublicKey,
    peer: { host: peer.host, port: peer.port },
  };

  const controller = new AbortController();
  const commitRemoteCheckpoint = () => job; // no-op checkpoint commit for CLI
  const checkpoint = {
    files: sourceManifest.files.map((f) => ({ path: f.path, size: f.size, committedOffset: 0, completed: false })),
    nextSequence: 0,
    totalTransferred: 0,
  };

  process.stdout.write('Starting encrypted transfer...\n');
  try {
    const executor = await createDesktopTransferExecutor({
      job: job as never,
      checkpoint: checkpoint as never,
      signal: controller.signal,
      commitRemoteCheckpoint: commitRemoteCheckpoint as never,
      localDevice: {
        deviceId: device.deviceId,
        signingPrivateKey: device.signingPrivateKey,
      },
      trustedPeerStore: {
        getTrustedPeer: () => ({
          identity: {
            deviceId: peer.deviceId,
            signingPublicKey: peer.signingPublicKey,
            encryptionPublicKey: peer.encryptionPublicKey,
          },
          permissions: { transfer: true },
        }),
      },
      lanService: {
        listPeers: () => [peer as never],
      },
    });

    executor.done.then(() => {
      process.stdout.write('\nTransfer completed successfully!\n');
    }).catch((error: Error) => {
      process.stderr.write(`\nTransfer failed: ${error.message}\n`);
      process.exit(1);
    });

    await executor.done;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Transfer setup failed: ${msg}\n`);
    process.exit(1);
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

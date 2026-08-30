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
  type DiscoveredPeerEntry,
} from '@luo-5/core';
import { loadOrCreateDevice, parseCommonOptions, requireTrustedPeerIdentity } from '../device.js';
import { commitCliCheckpoint, createCliTransferContext } from '../transfer-context.js';

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
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  discovery.stop();

  if (!targetPeer) {
    process.stderr.write(`Device not found: ${values.to}\n`);
    process.exit(1);
  }

  const peer = targetPeer as DiscoveredPeerEntry;
  await requireTrustedPeerIdentity(peer, opts.dataDir);
  process.stdout.write(`Connected to: ${peer.deviceName} (${peer.deviceId})\n`);
  process.stdout.write(`  Address: ${peer.host}:${peer.port}\n\n`);

  // Hash only after the requested peer has been found and its current identity
  // has been checked. A typo in --to should not scan large local files.
  process.stdout.write('Building manifest...\n');
  const sourceManifest = await buildTransferSourceManifest(filePaths);
  const manifest = sourceManifest.manifest;
  for (const file of sourceManifest.files) {
    process.stdout.write(`  ${file.path} (${formatBytes(file.size)})\n`);
  }
  process.stdout.write(`  Total: ${manifest.totalFiles} file(s), ${formatBytes(manifest.totalBytes)}\n\n`);

  const { job, trustedPeer } = createCliTransferContext({
    device,
    peer,
    manifest,
    sources: sourceManifest.files.map((file) => ({
      path: file.path,
      sourcePath: file.sourcePath,
      size: file.size,
      sha256: file.sha256,
    })),
  });

  const controller = new AbortController();
  let interrupted = false;
  const onSignal = () => {
    if (interrupted) return;
    interrupted = true;
    process.stderr.write('\nStopping transfer...\n');
    controller.abort(new Error('Transfer interrupted by user'));
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
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
    process.stdout.write('\nTransfer completed successfully!\n');
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${interrupted ? 'Transfer interrupted' : 'Transfer failed'}: ${msg}\n`);
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

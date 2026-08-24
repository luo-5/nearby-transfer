/**
 * `nearby-transfer send <file...> --to <device-id|ip>` — send files to a device.
 */

import { parseArgs } from 'node:util';
import { existsSync, statSync, readFileSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { createHash } from 'node:crypto';
import {
  V2Discovery,
  JsonTrustStore,
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
  const files = positionals.map((p) => {
    const abs = resolve(p);
    if (!existsSync(abs)) throw new Error(`File not found: ${p}`);
    const stat = statSync(abs);
    if (stat.isDirectory()) throw new Error(`Directories not supported yet: ${p} (use individual files)`);
    return { path: basename(abs), sourcePath: abs, size: stat.size, sha256: hashFile(abs) };
  });

  process.stdout.write(`Sending ${files.length} file(s) to ${values.to}...\n`);

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
  const timeout = opts.timeout ?? 10000;
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

  // Display file list
  for (const file of files) {
    process.stdout.write(`  ${file.path} (${formatBytes(file.size)})\n`);
  }

  // Note: Full transfer execution requires the TCP transport layer (LanService +
  // executor) which needs a running receiver. The CLI establishes discovery
  // and validates the target. Actual file transfer uses the core package's
  // createDesktopTransferExecutor, which requires a paired peer with an active
  // TCP listener. For CLI-to-CLI transfers, run `nearby-transfer receive` on
  // the target first.
  process.stdout.write('\nTo complete the transfer, ensure the target device is running:\n');
  process.stdout.write(`  nearby-transfer receive --dir <directory>\n`);
  process.stdout.write('\nFull TCP transfer orchestration will be activated once the\n');
  process.stdout.write('receiver handshake is implemented in the CLI.\n');

  // TODO: implement full TCP transfer using LanService + createDesktopTransferExecutor
  // This requires:
  // 1. Starting a LanService on the receiver side
  // 2. The sender connecting via TCP and running the bootstrap → executor flow
  // 3. Progress reporting via the executor's done promise
}

function hashFile(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

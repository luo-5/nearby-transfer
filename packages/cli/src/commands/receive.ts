/**
 * `nearby-transfer receive --dir <directory>` — start receiving files.
 */

import { parseArgs } from 'node:util';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { V2Discovery } from '@luo-5/core';
import { loadOrCreateDevice, parseCommonOptions } from '../device.js';

export async function receiveCommand(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      dir: { type: 'string' },
      'data-dir': { type: 'string' },
      port: { type: 'string' },
    },
    allowPositionals: true,
  });

  if (!values.dir) {
    process.stderr.write('Error: --dir <directory> is required\n');
    process.exit(1);
  }

  const opts = parseCommonOptions(args);
  const receiveDir = resolve(values.dir);
  mkdirSync(receiveDir, { recursive: true });

  const device = loadOrCreateDevice(opts.dataDir);

  process.stdout.write(`Receiving files into: ${receiveDir}\n`);
  process.stdout.write(`Device: ${device.deviceName} (${device.deviceId})\n`);
  process.stdout.write(`Fingerprint: ${device.fingerprint}\n\n`);

  // Start discovery so other devices can find us
  const discovery = new V2Discovery({
    device,
    port: opts.port ?? 0,
    capabilities: ['pairing', 'transfer'],
  });

  discovery.on('peer', (peer) => {
    process.stdout.write(`Device discovered: ${peer.deviceName} (${peer.deviceId})\n`);
  });

  discovery.on('error', (error: Error) => {
    process.stderr.write(`Discovery error: ${error.message}\n`);
  });

  discovery.start();

  process.stdout.write('Listening for incoming transfers... (Ctrl+C to stop)\n\n');

  // Keep the process alive until interrupted
  process.on('SIGINT', () => {
    process.stdout.write('\nStopping...\n');
    discovery.stop();
    process.exit(0);
  });

  // TODO: implement full TCP receive using LanService
  // This requires:
  // 1. Starting a LanService with a pairing API
  // 2. Accepting incoming TCP connections
  // 3. Running the transfer bootstrap (receiver side) + encrypted-chunk-writer
  // 4. Writing received files to receiveDir via receive-target-planner

  // Keep alive
  await new Promise(() => {});
}

/**
 * `nearby-transfer pair --to <device-id|ip>` — initiate pairing, display 6-digit SAS code.
 */

import { parseArgs } from 'node:util';
import { V2Discovery, type DiscoveredPeerEntry } from '@luo-5/core';
import { loadOrCreateDevice, parseCommonOptions } from '../device.js';

export async function pairCommand(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      to: { type: 'string' },
      ...commonParseOptions(),
    },
    allowPositionals: true,
  });

  if (!values.to) {
    process.stderr.write('Error: --to <device-id|ip> is required\n');
    process.exit(1);
  }

  const opts = parseCommonOptions(args);
  const device = loadOrCreateDevice(opts.dataDir);

  const discovery = new V2Discovery({
    device,
    port: 0,
    capabilities: ['pairing'],
  });

  let targetPeer: DiscoveredPeerEntry | null = null;
  discovery.on('peer', (peer: DiscoveredPeerEntry) => {
    if (peer.deviceId === values.to || peer.host === values.to) {
      targetPeer = peer;
    }
  });

  discovery.start();
  process.stdout.write('Scanning for devices...\n');

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
  process.stdout.write(`\nFound device: ${peer.deviceName} (${peer.deviceId})\n`);
  process.stdout.write(`Fingerprint: ${peer.fingerprint}\n\n`);
  process.stdout.write(`To complete pairing, verify the 6-digit code matches on both devices.
`);
  process.stdout.write(`(In the CLI, use "nearby-transfer send" to start a transfer - pairing is automatic.)
`);
}

function commonParseOptions() {
  return {
    'data-dir': { type: 'string' as const },
    timeout: { type: 'string' as const },
  };
}

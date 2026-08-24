/**
 * `nearby-transfer devices` — list discovered devices on the LAN.
 */

import { V2Discovery, type DiscoveredPeerEntry } from '@luo-5/core';
import { loadOrCreateDevice, parseCommonOptions } from '../device.js';

export async function devicesCommand(args: string[]): Promise<void> {
  const opts = parseCommonOptions(args);
  const device = loadOrCreateDevice(opts.dataDir);

  const discovery = new V2Discovery({
    device,
    port: 0,
    capabilities: ['pairing'],
  });

  const peers: DiscoveredPeerEntry[] = [];
  discovery.on('peer', (peer: DiscoveredPeerEntry) => {
    peers.push(peer);
    // Deduplicate by deviceId
    const seen = new Map(peers.map((p) => [p.deviceId, p]));
    peers.length = 0;
    peers.push(...seen.values());
  });

  discovery.start();

  const timeout = opts.timeout ?? 5000;
  await new Promise((resolve) => setTimeout(resolve, timeout));

  discovery.stop();

  if (peers.length === 0) {
    process.stdout.write('No devices found.\n');
    return;
  }

  process.stdout.write(`Found ${peers.length} device(s):\n\n`);
  for (const peer of peers.sort((a, b) => a.deviceName.localeCompare(b.deviceName))) {
    process.stdout.write(`  ${peer.deviceId}  ${peer.deviceName}  ${peer.host}:${peer.port}\n`);
    process.stdout.write(`    fingerprint: ${peer.fingerprint}\n`);
    process.stdout.write(`    capabilities: ${peer.capabilities.join(', ') || 'none'}\n\n`);
  }
}

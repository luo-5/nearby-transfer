/**
 * `nearby-transfer trust list` / `nearby-transfer trust remove <device-id>`
 */

import { parseArgs } from 'node:util';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { JsonTrustStore } from '@luo-5/core';
import { loadOrCreateDevice, parseCommonOptions } from '../device.js';

export async function trustCommand(args: string[]): Promise<void> {
  const subcommand = args[0];

  if (!subcommand || subcommand === 'list') {
    await trustList(args.slice(1));
  } else if (subcommand === 'remove') {
    await trustRemove(args.slice(1));
  } else {
    process.stderr.write(`Unknown trust subcommand: ${subcommand}\n`);
    process.stderr.write('Usage: nearby-transfer trust list | trust remove <device-id>\n');
    process.exit(1);
  }
}

async function trustList(args: string[]): Promise<void> {
  const opts = parseCommonOptions(args);
  // Ensure device identity exists
  loadOrCreateDevice(opts.dataDir);

  const store = new JsonTrustStore(opts.dataDir ?? getDataDir());
  const records = await store.load();

  if (records.length === 0) {
    process.stdout.write('No trusted devices.\n');
    return;
  }

  process.stdout.write(`Trusted devices (${records.length}):\n\n`);
  for (const record of records) {
    process.stdout.write(`  ${record.deviceId}  ${record.name}\n`);
    process.stdout.write(`    trusted at: ${new Date(record.trustedAt).toISOString()}\n\n`);
  }
}

async function trustRemove(args: string[]): Promise<void> {
  const { positionals } = parseArgs({
    args,
    options: {
      'data-dir': { type: 'string' },
    },
    allowPositionals: true,
  });

  if (positionals.length === 0) {
    process.stderr.write('Error: device-id is required\n');
    process.exit(1);
  }

  const deviceId = positionals[0]!;
  const opts = parseCommonOptions(args);
  const store = new JsonTrustStore(opts.dataDir ?? getDataDir());

  await store.remove(deviceId);
  process.stdout.write(`Removed trusted device: ${deviceId}\n`);
}

function getDataDir(): string {
  return join(homedir(), '.nearby-transfer');
}

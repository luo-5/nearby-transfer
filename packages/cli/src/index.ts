#!/usr/bin/env node

/**
 * @luo-5/cli — Command-line encrypted file transfer for nearby devices.
 *
 * Usage:
 *   nearby-transfer send <file...> --to <device-id|ip>
 *   nearby-transfer receive --dir <directory>
 *   nearby-transfer devices
 *   nearby-transfer pair --to <device-id|ip>
 *   nearby-transfer trust list
 *   nearby-transfer trust remove <device-id>
 */

import { parseArgs } from 'node:util';
import { sendCommand } from './commands/send.js';
import { receiveCommand } from './commands/receive.js';
import { devicesCommand } from './commands/devices.js';
import { pairCommand } from './commands/pair.js';
import { trustCommand } from './commands/trust.js';
import { syncCommand } from './commands/sync.js';

const HELP = `Nearby Transfer CLI — encrypted LAN file transfer

Usage:
  nearby-transfer send <file...> --to <device-id|ip>   Send files to a device
  nearby-transfer sync --dir <directory> --to <device-id|ip>  Sync a directory
  nearby-transfer receive --dir <directory>             Start receiving files
  nearby-transfer devices                               List discovered devices
  nearby-transfer pair --to <device-id|ip>              Inspect a pairing candidate (preview)
  nearby-transfer trust list                            List trusted devices
  nearby-transfer trust remove <device-id>              Remove a trusted device

Options:
  --port <port>     Override the default port (0 = random)
  --timeout <ms>    Discovery timeout in ms (default: 5000)
  --data-dir <dir>  Data directory (default: ~/.nearby-transfer)
  -h, --help        Show this help

Examples:
  nearby-transfer devices
  nearby-transfer send ./report.pdf --to 192.168.1.50
  nearby-transfer send ./photos/ --to a1b2c3d4e5f60718
  nearby-transfer receive --dir ~/Downloads
`;

export async function main(argv: string[]): Promise<void> {
  const args = argv.slice(2);

  if (args.length === 0 || args[0] === '-h' || args[0] === '--help') {
    process.stdout.write(HELP);
    return;
  }

  const command = args[0]!;
  const rest = args.slice(1);

  try {
    switch (command) {
      case 'send':
        await sendCommand(rest);
        break;
      case 'sync':
        await syncCommand(rest);
        break;
      case 'receive':
        await receiveCommand(rest);
        break;
      case 'devices':
        await devicesCommand(rest);
        break;
      case 'pair':
        await pairCommand(rest);
        break;
      case 'trust':
        await trustCommand(rest);
        break;
      default:
        process.stderr.write(`Unknown command: ${command}\n\n`);
        process.stdout.write(HELP);
        process.exit(1);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Error: ${message}\n`);
    process.exit(1);
  }
}

main(process.argv).catch((error) => {
  process.stderr.write(`Fatal: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});

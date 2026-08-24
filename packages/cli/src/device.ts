/**
 * Device identity persistence for the CLI.
 * Stores the Ed25519/X25519 keypair and derived device metadata in a JSON file
 * at <data-dir>/device.json. On first run, generates a new identity.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { parseArgs } from 'node:util';
import {
  createEd25519KeyPair,
  createX25519KeyPair,
  deriveDeviceId,
  fingerprintFor,
} from '@luo-5/core';

export interface CliDevice {
  deviceId: string;
  deviceName: string;
  fingerprint: string;
  signingPublicKey: string;
  signingPrivateKey: string;
  encryptionPublicKey: string;
  encryptionPrivateKey: string;
}

const DEVICE_FILE = 'device.json';
const DEFAULT_DATA_DIR = () => join(homedir(), '.nearby-transfer');

export function getDataDir(override?: string): string {
  return override ?? DEFAULT_DATA_DIR();
}

export function loadOrCreateDevice(dataDir?: string): CliDevice {
  const dir = getDataDir(dataDir);
  mkdirSync(dir, { recursive: true });
  const devicePath = join(dir, DEVICE_FILE);

  if (existsSync(devicePath)) {
    const data = JSON.parse(readFileSync(devicePath, 'utf8'));
    return data as CliDevice;
  }

  const signing = createEd25519KeyPair();
  const encryption = createX25519KeyPair();
  const deviceId = deriveDeviceId(signing.publicKey);
  const device: CliDevice = {
    deviceId,
    deviceName: `cli-${deviceId.slice(0, 8)}`,
    fingerprint: fingerprintFor(signing.publicKey),
    signingPublicKey: signing.publicKey,
    signingPrivateKey: signing.privateKey,
    encryptionPublicKey: encryption.publicKey,
    encryptionPrivateKey: encryption.privateKey,
  };

  writeFileSync(devicePath, JSON.stringify(device, null, 2) + '\n', { mode: 0o600 });
  return device;
}

/** Parse CLI options that are common to most commands. */
export function parseCommonOptions(args: string[]): { dataDir: string | undefined; port: number | undefined; timeout: number | undefined } {
  const { values } = parseArgs({
    args,
    options: {
      'data-dir': { type: 'string' },
      port: { type: 'string' },
      timeout: { type: 'string' },
    },
    allowPositionals: true,
  });
  const result: { dataDir: string | undefined; port: number | undefined; timeout: number | undefined } = {
    dataDir: values['data-dir'],
    port: undefined,
    timeout: undefined,
  };
  if (values.port) result.port = Number(values.port);
  if (values.timeout) result.timeout = Number(values.timeout);
  return result;
}

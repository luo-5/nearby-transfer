/**
 * Device identity persistence for the CLI.
 * Stores the Ed25519/X25519 keypair and derived device metadata in a JSON file
 * at <data-dir>/device.json. On first run, generates a new identity.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { parseArgs } from 'node:util';
import { createPublicKey, timingSafeEqual } from 'node:crypto';
import { Buffer } from 'node:buffer';
import {
  createEd25519KeyPair,
  createX25519KeyPair,
  deriveDeviceId,
  fingerprintFor,
  JsonTrustStore,
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

export interface DiscoveredTrustIdentity {
  deviceId: string;
  signingPublicKey: string;
}

/**
 * Require a discovered peer to match a previously persisted CLI trust record.
 * Discovery announcements are signed, but a self-signed announcement is not trust
 * on its own. Send/sync must therefore fail closed for unknown or changed keys.
 */
export async function requireTrustedPeerIdentity(
  peer: DiscoveredTrustIdentity,
  dataDir?: string,
): Promise<void> {
  const store = new JsonTrustStore(getDataDir(dataDir));
  const record = await store.get(peer.deviceId);
  if (!record) {
    throw new Error(
      `Device ${peer.deviceId} is not trusted. CLI mutual pairing is not implemented yet; do not bypass this check.`,
    );
  }

  let discoveredKey: Buffer;
  try {
    const der = createPublicKey(peer.signingPublicKey).export({ type: 'spki', format: 'der' });
    discoveredKey = Buffer.from(der).subarray(-32);
  } catch {
    throw new Error(`Device ${peer.deviceId} announced an invalid Ed25519 signing key.`);
  }

  const trustedKey = Buffer.from(record.signingPublicKey);
  if (
    trustedKey.length !== discoveredKey.length ||
    !timingSafeEqual(trustedKey, discoveredKey)
  ) {
    throw new Error(`Device ${peer.deviceId} signing key does not match the trusted record.`);
  }
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
  if (values['data-dir'] !== undefined && values['data-dir'].trim().length === 0) {
    throw new TypeError('--data-dir must not be empty');
  }
  if (values.port !== undefined) result.port = parseIntegerOption(values.port, '--port', 0, 65535);
  if (values.timeout !== undefined) result.timeout = parseIntegerOption(values.timeout, '--timeout', 1, 10 * 60 * 1000);
  return result;
}

function parseIntegerOption(value: string, label: string, minimum: number, maximum: number): number {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new TypeError(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new TypeError(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

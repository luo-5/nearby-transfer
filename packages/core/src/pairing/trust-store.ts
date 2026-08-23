/**
 * JSON-file trust store for paired peers. Implements the TrustStore interface
 * from types.ts.
 *
 * Replaces the SQLite-backed TrustedPeerStore (src/v2/trusted-peer-store.js)
 * with a zero-native-dependency JSON file, keeping the core package portable.
 * The full permission/revocation model from the desktop store is handled by
 * the desktop adapter layer; this store captures the essential trust record:
 * deviceId, name, signing public key, and trusted-at timestamp.
 *
 * signingPublicKey (Uint8Array) is serialized as base64 in the JSON file and
 * restored to Uint8Array on load.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Buffer } from 'node:buffer';
import type { TrustStore, TrustRecord } from '../types.js';

const TRUST_FILE = 'trusted-peers.json';
const DEVICE_ID_PATTERN = /^[a-f0-9]{16}$/;

interface SerializedRecord {
  deviceId: string;
  name: string;
  signingPublicKey: string; // base64
  trustedAt: number;
}

export class JsonTrustStore implements TrustStore {
  private filePath: string;

  constructor(dataDirectory: string) {
    if (typeof dataDirectory !== 'string' || dataDirectory.trim().length === 0) {
      throw new TypeError('A data directory is required');
    }
    mkdirSync(dataDirectory, { recursive: true });
    this.filePath = join(dataDirectory, TRUST_FILE);
  }

  async load(): Promise<TrustRecord[]> {
    return this.loadSync();
  }

  loadSync(): TrustRecord[] {
    if (!existsSync(this.filePath)) return [];
    try {
      const data = JSON.parse(readFileSync(this.filePath, 'utf8'));
      if (!Array.isArray(data)) return [];
      return data.filter(isValidSerialized).map(deserializeRecord);
    } catch {
      return [];
    }
  }

  async get(deviceId: string): Promise<TrustRecord | null> {
    assertDeviceId(deviceId);
    const records = this.loadSync();
    return records.find((r) => r.deviceId === deviceId) ?? null;
  }

  async save(record: TrustRecord): Promise<void> {
    assertValidRecord(record);
    const records = this.loadSync();
    const index = records.findIndex((r) => r.deviceId === record.deviceId);
    if (index >= 0) {
      records[index] = record;
    } else {
      records.push(record);
    }
    this.writeSync(records.map(serializeRecord));
  }

  async remove(deviceId: string): Promise<void> {
    assertDeviceId(deviceId);
    const records = this.loadSync();
    const filtered = records.filter((r) => r.deviceId !== deviceId);
    if (filtered.length !== records.length) this.writeSync(filtered.map(serializeRecord));
  }

  async clear(): Promise<void> {
    this.writeSync([]);
  }

  private writeSync(records: SerializedRecord[]): void {
    writeFileSync(this.filePath, JSON.stringify(records, null, 2) + '\n', { mode: 0o600 });
  }
}

function serializeRecord(record: TrustRecord): SerializedRecord {
  return {
    deviceId: record.deviceId,
    name: record.name,
    signingPublicKey: Buffer.from(record.signingPublicKey).toString('base64'),
    trustedAt: record.trustedAt,
  };
}

function deserializeRecord(record: SerializedRecord): TrustRecord {
  return {
    deviceId: record.deviceId,
    name: record.name,
    signingPublicKey: new Uint8Array(Buffer.from(record.signingPublicKey, 'base64')),
    trustedAt: record.trustedAt,
  };
}

export function assertDeviceId(deviceId: string): void {
  if (typeof deviceId !== 'string' || !DEVICE_ID_PATTERN.test(deviceId)) {
    throw new TypeError('Device ID must be 16 lowercase hexadecimal characters');
  }
}

function isValidSerialized(value: unknown): value is SerializedRecord {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.deviceId === 'string' && DEVICE_ID_PATTERN.test(v.deviceId) && typeof v.name === 'string' && typeof v.signingPublicKey === 'string' && typeof v.trustedAt === 'number';
}

function assertValidRecord(record: TrustRecord): void {
  if (!record || typeof record !== 'object') throw new TypeError('Trust record must be an object');
  assertDeviceId(record.deviceId);
  if (typeof record.name !== 'string' || record.name.length === 0) throw new TypeError('Trust record name is invalid');
  if (!(record.signingPublicKey instanceof Uint8Array) && !Buffer.isBuffer(record.signingPublicKey)) {
    throw new TypeError('Trust record signingPublicKey must be a Uint8Array');
  }
  if (!Number.isSafeInteger(record.trustedAt) || record.trustedAt <= 0) throw new TypeError('Trust record trustedAt must be a positive integer');
}

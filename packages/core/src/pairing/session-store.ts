/**
 * JSON-file pairing session store. Implements the SessionStore interface from
 * types.ts.
 *
 * Replaces the SQLite-backed PairingSessionStore (src/v2/pairing-session-store.js)
 * with a zero-native-dependency JSON file. Each session is keyed by pairingId
 * and stored as an opaque JSON value; the full pairing state machine lives in
 * the desktop adapter layer.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionStore } from '../types.js';

const SESSION_FILE = 'pairing-sessions.json';
const PAIRING_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;

export class JsonSessionStore implements SessionStore {
  private filePath: string;

  constructor(dataDirectory: string) {
    if (typeof dataDirectory !== 'string' || dataDirectory.trim().length === 0) {
      throw new TypeError('A data directory is required');
    }
    mkdirSync(dataDirectory, { recursive: true });
    this.filePath = join(dataDirectory, SESSION_FILE);
  }

  async get(pairingId: string): Promise<unknown> {
    assertPairingId(pairingId);
    return this.loadSync()[pairingId] ?? null;
  }

  async save(pairingId: string, session: unknown): Promise<void> {
    assertPairingId(pairingId);
    const data = this.loadSync();
    data[pairingId] = session;
    this.writeSync(data);
  }

  async remove(pairingId: string): Promise<void> {
    assertPairingId(pairingId);
    const data = this.loadSync();
    if (pairingId in data) {
      delete data[pairingId];
      this.writeSync(data);
    }
  }

  async clear(): Promise<void> {
    this.writeSync({});
  }

  private loadSync(): Record<string, unknown> {
    if (!existsSync(this.filePath)) return {};
    try {
      const data = JSON.parse(readFileSync(this.filePath, 'utf8'));
      if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
      return data as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  private writeSync(data: Record<string, unknown>): void {
    writeFileSync(this.filePath, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  }
}

function assertPairingId(pairingId: string): void {
  if (typeof pairingId !== 'string' || !PAIRING_ID_PATTERN.test(pairingId)) {
    throw new TypeError('Pairing ID must be a 16-byte base64url value');
  }
}

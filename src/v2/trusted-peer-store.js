'use strict';

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { assertValidPublicIdentity } = require('./pairing');

const DATABASE_FILE = 'nearby-transfer-v2.sqlite';

class TrustedPeerStore {
  constructor(userDataDir) {
    if (typeof userDataDir !== 'string' || userDataDir.trim().length === 0) {
      throw new TypeError('A user-data directory is required');
    }
    fs.mkdirSync(userDataDir, { recursive: true });
    this.databasePath = path.join(userDataDir, DATABASE_FILE);
    this.database = new DatabaseSync(this.databasePath, { enableForeignKeyConstraints: true });
    this._migrate();
  }

  upsertTrustedPeer({ identity, displayName, permissions = {}, pairedAt = Date.now() }) {
    const peer = assertValidPublicIdentity(identity);
    const name = normalizeDisplayName(displayName || peer.deviceName);
    const grants = normalizePermissions(permissions);
    assertTimestamp(pairedAt, 'Pairing time');
    const updatedAt = Date.now();

    this.database.prepare(`
      INSERT INTO trusted_peers (
        device_id, device_name, display_name, fingerprint, signing_public_key, encryption_public_key,
        transfer_allowed, library_read_allowed, library_upload_allowed, paired_at, revoked_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
      ON CONFLICT(device_id) DO UPDATE SET
        device_name = excluded.device_name,
        display_name = excluded.display_name,
        fingerprint = excluded.fingerprint,
        signing_public_key = excluded.signing_public_key,
        encryption_public_key = excluded.encryption_public_key,
        transfer_allowed = excluded.transfer_allowed,
        library_read_allowed = excluded.library_read_allowed,
        library_upload_allowed = excluded.library_upload_allowed,
        paired_at = excluded.paired_at,
        revoked_at = NULL,
        updated_at = excluded.updated_at
    `).run(
      peer.deviceId,
      peer.deviceName,
      name,
      peer.fingerprint,
      peer.signingPublicKey,
      peer.encryptionPublicKey,
      grants.transfer ? 1 : 0,
      grants.libraryRead ? 1 : 0,
      grants.libraryUpload ? 1 : 0,
      pairedAt,
      updatedAt
    );
    return this.getTrustedPeer(peer.deviceId, { includeRevoked: true });
  }

  getTrustedPeer(deviceId, { includeRevoked = false } = {}) {
    assertDeviceId(deviceId);
    const row = this.database.prepare(`
      SELECT * FROM trusted_peers
      WHERE device_id = ? ${includeRevoked ? '' : 'AND revoked_at IS NULL'}
    `).get(deviceId);
    return row ? rowToPeer(row) : null;
  }

  listTrustedPeers({ includeRevoked = false } = {}) {
    const rows = this.database.prepare(`
      SELECT * FROM trusted_peers
      ${includeRevoked ? '' : 'WHERE revoked_at IS NULL'}
      ORDER BY display_name COLLATE NOCASE ASC, device_id ASC
    `).all();
    return rows.map(rowToPeer);
  }

  revokeTrustedPeer(deviceId, revokedAt = Date.now()) {
    assertDeviceId(deviceId);
    assertTimestamp(revokedAt, 'Revocation time');
    const result = this.database.prepare(`
      UPDATE trusted_peers
      SET revoked_at = ?, updated_at = ?
      WHERE device_id = ? AND revoked_at IS NULL
    `).run(revokedAt, Date.now(), deviceId);
    return result.changes === 1;
  }

  deleteTrustedPeer(deviceId) {
    assertDeviceId(deviceId);
    const result = this.database.prepare('DELETE FROM trusted_peers WHERE device_id = ?').run(deviceId);
    return result.changes === 1;
  }

  close() {
    this.database.close();
  }

  _migrate() {
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS trusted_peers (
        device_id TEXT PRIMARY KEY,
        device_name TEXT NOT NULL,
        display_name TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        signing_public_key TEXT NOT NULL UNIQUE,
        encryption_public_key TEXT NOT NULL,
        transfer_allowed INTEGER NOT NULL CHECK(transfer_allowed IN (0, 1)),
        library_read_allowed INTEGER NOT NULL CHECK(library_read_allowed IN (0, 1)),
        library_upload_allowed INTEGER NOT NULL CHECK(library_upload_allowed IN (0, 1)),
        paired_at INTEGER NOT NULL,
        revoked_at INTEGER,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS trusted_peers_active_name
        ON trusted_peers(revoked_at, display_name COLLATE NOCASE, device_id);
    `);
    this.database.prepare(`
      INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (1, ?)
    `).run(Date.now());
  }
}

function normalizePermissions(permissions) {
  if (!permissions || typeof permissions !== 'object' || Array.isArray(permissions)) {
    throw new TypeError('Peer permissions must be an object');
  }
  const normalized = {
    transfer: permissions.transfer !== false,
    libraryRead: permissions.libraryRead === true,
    libraryUpload: permissions.libraryUpload === true
  };
  if (normalized.libraryUpload && !normalized.libraryRead) {
    throw new TypeError('Library upload permission requires library read permission');
  }
  for (const key of Object.keys(permissions)) {
    if (!['transfer', 'libraryRead', 'libraryUpload'].includes(key) || typeof permissions[key] !== 'boolean') {
      throw new TypeError(`Invalid peer permission: ${key}`);
    }
  }
  return normalized;
}

function normalizeDisplayName(value) {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 128) {
    throw new TypeError('Peer display name is invalid');
  }
  return value.trim();
}

function assertDeviceId(deviceId) {
  if (typeof deviceId !== 'string' || !/^[a-f0-9]{16}$/.test(deviceId)) {
    throw new TypeError('Device ID must be 16 lowercase hexadecimal characters');
  }
}

function assertTimestamp(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
}

function rowToPeer(row) {
  return {
    identity: {
      deviceId: row.device_id,
      deviceName: row.device_name,
      fingerprint: row.fingerprint,
      signingPublicKey: row.signing_public_key,
      encryptionPublicKey: row.encryption_public_key
    },
    displayName: row.display_name,
    permissions: {
      transfer: row.transfer_allowed === 1,
      libraryRead: row.library_read_allowed === 1,
      libraryUpload: row.library_upload_allowed === 1
    },
    pairedAt: row.paired_at,
    revokedAt: row.revoked_at,
    updatedAt: row.updated_at
  };
}

module.exports = {
  DATABASE_FILE,
  TrustedPeerStore,
  normalizePermissions
};

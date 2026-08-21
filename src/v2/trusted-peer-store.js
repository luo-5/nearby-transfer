'use strict';

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { assertValidPublicIdentity } = require('./pairing');

const DATABASE_FILE = 'nearby-transfer-v2.sqlite';
const CORRUPTION_CODES = new Set(['SQLITE_CORRUPT', 'SQLITE_NOTADB']);
const CORRUPTION_MESSAGES = [
  'database disk image is malformed',
  'file is not a database',
  'database corruption detected'
];

class TrustedPeerStore {
  constructor(userDataDir) {
    if (typeof userDataDir !== 'string' || userDataDir.trim().length === 0) {
      throw new TypeError('A user-data directory is required');
    }
    fs.mkdirSync(userDataDir, { recursive: true });
    this.databasePath = path.join(userDataDir, DATABASE_FILE);
    this.database = null;
    this.corruptDatabaseBackupPath = null;
    this._openWithRecovery();
  }

  upsertTrustedPeer(options) {
    assertPlainObject(options, 'Trusted peer');
    assertAllowedKeys(options, ['identity', 'displayName', 'permissions', 'pairedAt', 'lastSeen'], 'trusted peer');
    const {
      identity,
      displayName,
      permissions = {},
      pairedAt = Date.now(),
      lastSeen = pairedAt
    } = options;
    const peer = assertValidPublicIdentity(identity);
    const name = normalizeDisplayName(displayName || peer.deviceName);
    const grants = normalizePermissions(permissions);
    assertTimestamp(pairedAt, 'Pairing time');
    assertTimestamp(lastSeen, 'Last-seen time');

    return this._transaction(() => {
      const existing = this.database.prepare(
        'SELECT * FROM trusted_peers WHERE device_id = ?'
      ).get(peer.deviceId);
      if (existing) {
        assertIdentityUnchanged(existing, peer);
      }
      const updatedAt = nextUpdatedAt(existing && existing.updated_at);
      const effectiveLastSeen = existing ? Math.max(existing.last_seen || existing.paired_at, lastSeen) : lastSeen;

      this.database.prepare(`
        INSERT INTO trusted_peers (
          device_id, device_name, display_name, fingerprint, signing_public_key, encryption_public_key,
          transfer_allowed, library_read_allowed, library_upload_allowed, paired_at, last_seen, revoked_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
        ON CONFLICT(device_id) DO UPDATE SET
          device_name = excluded.device_name,
          display_name = excluded.display_name,
          transfer_allowed = excluded.transfer_allowed,
          library_read_allowed = excluded.library_read_allowed,
          library_upload_allowed = excluded.library_upload_allowed,
          paired_at = excluded.paired_at,
          last_seen = excluded.last_seen,
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
        effectiveLastSeen,
        updatedAt
      );
      return this.getTrustedPeer(peer.deviceId, { includeRevoked: true });
    });
  }

  getTrustedPeer(deviceId, options = {}) {
    assertDeviceId(deviceId);
    const { includeRevoked } = normalizeQueryOptions(options);
    const row = this.database.prepare(`
      SELECT * FROM trusted_peers
      WHERE device_id = ? ${includeRevoked ? '' : 'AND revoked_at IS NULL'}
    `).get(deviceId);
    return row ? rowToPeer(row) : null;
  }

  listTrustedPeers(options = {}) {
    const { includeRevoked } = normalizeQueryOptions(options);
    const rows = this.database.prepare(`
      SELECT * FROM trusted_peers
      ${includeRevoked ? '' : 'WHERE revoked_at IS NULL'}
      ORDER BY display_name COLLATE NOCASE ASC, device_id ASC
    `).all();
    return rows.map(rowToPeer);
  }

  updateTrustedPeerDisplayName(deviceId, displayName) {
    return this.updateTrustedPeer(deviceId, { displayName });
  }

  updateTrustedPeerPermissions(deviceId, permissions) {
    return this.updateTrustedPeer(deviceId, { permissions });
  }

  updateTrustedPeer(deviceId, options) {
    assertDeviceId(deviceId);
    assertPlainObject(options, 'Trusted peer update');
    assertAllowedKeys(options, ['displayName', 'permissions'], 'trusted peer update');
    if (Object.keys(options).length === 0) {
      throw new TypeError('Trusted peer update must contain a field');
    }
    const hasDisplayName = Object.hasOwn(options, 'displayName');
    const hasPermissions = Object.hasOwn(options, 'permissions');
    const name = hasDisplayName ? normalizeDisplayName(options.displayName) : null;
    if (hasPermissions) assertPermissionPatch(options.permissions);

    return this._transaction(() => {
      const existing = this.database.prepare(`
        SELECT display_name, transfer_allowed, library_read_allowed, library_upload_allowed, updated_at
        FROM trusted_peers
        WHERE device_id = ? AND revoked_at IS NULL
      `).get(deviceId);
      if (!existing) {
        return false;
      }
      const grants = hasPermissions ? normalizePermissionPatch(options.permissions, existing) : {
        transfer: existing.transfer_allowed === 1,
        libraryRead: existing.library_read_allowed === 1,
        libraryUpload: existing.library_upload_allowed === 1
      };
      this.database.prepare(`
        UPDATE trusted_peers
        SET display_name = ?, transfer_allowed = ?, library_read_allowed = ?, library_upload_allowed = ?, updated_at = ?
        WHERE device_id = ? AND revoked_at IS NULL
      `).run(
        hasDisplayName ? name : existing.display_name,
        grants.transfer ? 1 : 0,
        grants.libraryRead ? 1 : 0,
        grants.libraryUpload ? 1 : 0,
        nextUpdatedAt(existing.updated_at),
        deviceId
      );
      return this.getTrustedPeer(deviceId, { includeRevoked: true });
    });
  }

  markTrustedPeerSeen(deviceId, seenAt = Date.now()) {
    assertDeviceId(deviceId);
    assertTimestamp(seenAt, 'Last-seen time');
    return this._transaction(() => {
      const existing = this.database.prepare(`
        SELECT last_seen, updated_at FROM trusted_peers
        WHERE device_id = ? AND revoked_at IS NULL
      `).get(deviceId);
      if (!existing || seenAt <= existing.last_seen) {
        return false;
      }
      const result = this.database.prepare(`
        UPDATE trusted_peers
        SET last_seen = ?, updated_at = ?
        WHERE device_id = ? AND revoked_at IS NULL
      `).run(seenAt, nextUpdatedAt(existing.updated_at), deviceId);
      return result.changes === 1;
    });
  }

  revokeTrustedPeer(deviceId, revokedAt = Date.now()) {
    assertDeviceId(deviceId);
    assertTimestamp(revokedAt, 'Revocation time');
    return this._transaction(() => {
      const existing = this.database.prepare(`
        SELECT updated_at FROM trusted_peers
        WHERE device_id = ? AND revoked_at IS NULL
      `).get(deviceId);
      if (!existing) {
        return false;
      }
      const result = this.database.prepare(`
        UPDATE trusted_peers
        SET revoked_at = ?, updated_at = ?
        WHERE device_id = ? AND revoked_at IS NULL
      `).run(revokedAt, nextUpdatedAt(existing.updated_at), deviceId);
      return result.changes === 1;
    });
  }

  deleteTrustedPeer(deviceId) {
    assertDeviceId(deviceId);
    const result = this.database.prepare('DELETE FROM trusted_peers WHERE device_id = ?').run(deviceId);
    return result.changes === 1;
  }

  close() {
    if (this.database) {
      this.database.close();
      this.database = null;
    }
  }

  _openWithRecovery() {
    try {
      this._open();
    } catch (error) {
      this._closeAfterFailure();
      if (!isDatabaseCorruptionError(error) || !fs.existsSync(this.databasePath)) {
        throw error;
      }
      this.corruptDatabaseBackupPath = quarantineCorruptDatabase(this.databasePath);
      try {
        this._open();
      } catch (recoveryError) {
        this._closeAfterFailure();
        throw recoveryError;
      }
    }
  }

  _open() {
    this.database = new DatabaseSync(this.databasePath, { enableForeignKeyConstraints: true });
    this._migrate();
    this._assertHealthy();
  }

  _closeAfterFailure() {
    if (!this.database) {
      return;
    }
    try {
      this.database.close();
    } catch {
      // Preserve the original database error; recovery still quarantines the file.
    }
    this.database = null;
  }

  _assertHealthy() {
    const rows = this.database.prepare('PRAGMA quick_check').all();
    if (rows.length !== 1 || rows[0].quick_check !== 'ok') {
      const error = new Error('Database corruption detected by SQLite quick_check');
      error.code = 'SQLITE_CORRUPT';
      throw error;
    }
  }

  _transaction(operation) {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.database.exec('ROLLBACK');
      } catch {
        // Keep the operation error, which is more useful than a rollback failure.
      }
      throw error;
    }
  }

  _migrate() {
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
    `);
    this._transaction(() => {
      this.database.exec(`
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
          last_seen INTEGER NOT NULL,
          revoked_at INTEGER,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS trusted_peers_active_name
          ON trusted_peers(revoked_at, display_name COLLATE NOCASE, device_id);
      `);
      this.database.prepare(`
        INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (1, ?)
      `).run(Date.now());

      const columns = this.database.prepare('PRAGMA table_info(trusted_peers)').all();
      if (!columns.some((column) => column.name === 'last_seen')) {
        this.database.exec('ALTER TABLE trusted_peers ADD COLUMN last_seen INTEGER');
        this.database.exec('UPDATE trusted_peers SET last_seen = MAX(paired_at, updated_at) WHERE last_seen IS NULL');
      }
      this.database.prepare(`
        INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (2, ?)
      `).run(Date.now());
    });
  }
}

function normalizePermissions(permissions) {
  if (!permissions || typeof permissions !== 'object' || Array.isArray(permissions)) {
    throw new TypeError('Peer permissions must be an object');
  }
  const normalized = {
    transfer: permissions.transfer !== false,
    libraryRead: permissions.libraryRead !== false,
    libraryUpload: permissions.libraryUpload !== false
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

function assertPermissionPatch(permissions) {
  assertPlainObject(permissions, 'Peer permissions');
  assertAllowedKeys(permissions, ['transfer', 'libraryRead', 'libraryUpload'], 'peer permission update');
  for (const key of Object.keys(permissions)) {
    if (typeof permissions[key] !== 'boolean') {
      throw new TypeError(`Invalid peer permission: ${key}`);
    }
  }
}

function normalizePermissionPatch(permissions, existing) {
  return normalizePermissions({
    transfer: permissions.transfer === undefined ? existing.transfer_allowed === 1 : permissions.transfer,
    libraryRead: permissions.libraryRead === undefined ? existing.library_read_allowed === 1 : permissions.libraryRead,
    libraryUpload: permissions.libraryUpload === undefined ? existing.library_upload_allowed === 1 : permissions.libraryUpload
  });
}

function normalizeDisplayName(value) {
  if (typeof value !== 'string') {
    throw new TypeError('Peer display name is invalid');
  }
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 128) {
    throw new TypeError('Peer display name is invalid');
  }
  return normalized;
}

function normalizeQueryOptions(options) {
  assertPlainObject(options, 'Query options');
  assertAllowedKeys(options, ['includeRevoked'], 'query option');
  if (options.includeRevoked !== undefined && typeof options.includeRevoked !== 'boolean') {
    throw new TypeError('includeRevoked must be a boolean');
  }
  return { includeRevoked: options.includeRevoked === true };
}

function assertPlainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
}

function assertAllowedKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new TypeError(`Invalid ${label}: ${key}`);
    }
  }
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

function assertIdentityUnchanged(row, peer) {
  const changedFields = [];
  if (row.fingerprint !== peer.fingerprint) changedFields.push('fingerprint');
  if (row.signing_public_key !== peer.signingPublicKey) changedFields.push('signing key');
  if (row.encryption_public_key !== peer.encryptionPublicKey) changedFields.push('encryption key');
  if (changedFields.length > 0) {
    const error = new Error(`Trusted peer identity changed: ${changedFields.join(', ')}`);
    error.code = 'TRUSTED_PEER_IDENTITY_CHANGED';
    error.deviceId = peer.deviceId;
    error.changedFields = changedFields;
    throw error;
  }
}

function nextUpdatedAt(previous) {
  const now = Date.now();
  if (!Number.isSafeInteger(previous) || previous < 1) {
    return now;
  }
  return Math.max(now, previous + 1);
}

function isDatabaseCorruptionError(error) {
  if (!error) return false;
  if (CORRUPTION_CODES.has(error.code)) return true;
  const message = String(error.message || '').toLowerCase();
  return CORRUPTION_MESSAGES.some((fragment) => message.includes(fragment));
}

function quarantineCorruptDatabase(databasePath) {
  const backupBase = uniqueCorruptBackupPath(databasePath);
  fs.renameSync(databasePath, backupBase);
  for (const suffix of ['-wal', '-shm']) {
    const source = `${databasePath}${suffix}`;
    if (fs.existsSync(source)) {
      fs.renameSync(source, `${backupBase}${suffix}`);
    }
  }
  return backupBase;
}

function uniqueCorruptBackupPath(databasePath) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  let candidate = `${databasePath}.corrupt-${timestamp}`;
  let counter = 0;
  while (fs.existsSync(candidate)) {
    counter += 1;
    candidate = `${databasePath}.corrupt-${timestamp}-${counter}`;
  }
  return candidate;
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
    lastSeen: row.last_seen || row.paired_at,
    revokedAt: row.revoked_at,
    updatedAt: row.updated_at
  };
}

module.exports = {
  DATABASE_FILE,
  TrustedPeerStore,
  normalizePermissions
};

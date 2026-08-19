'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { createKeyPair, createX25519KeyPair, fingerprintFor } = require('../src/core/crypto');
const { DATABASE_FILE, TrustedPeerStore, normalizePermissions } = require('../src/v2/trusted-peer-store');

function createIdentity(name) {
  const signing = createKeyPair('ed25519');
  const encryption = createX25519KeyPair();
  return {
    deviceId: crypto.createHash('sha256').update(signing.publicKey).digest('hex').slice(0, 16),
    deviceName: name,
    fingerprint: fingerprintFor(signing.publicKey),
    signingPublicKey: signing.publicKey,
    encryptionPublicKey: encryption.publicKey
  };
}

function withTempDirectory(prefix, callback) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    callback(directory);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

function withTrustedPeerStore(directory, callback) {
  const store = new TrustedPeerStore(directory);
  try {
    return callback(store);
  } finally {
    store.close();
  }
}

function testPersistenceAndMetadata() {
  withTempDirectory('nearby-transfer-peer-store-', (tempDir) => {
    const alpha = createIdentity('Alpha laptop');
    const bravo = createIdentity('Bravo phone');

    withTrustedPeerStore(tempDir, (store) => {
      const storedAlpha = store.upsertTrustedPeer({
        identity: alpha,
        displayName: ' Alice workstation ',
        permissions: { transfer: true, libraryRead: true, libraryUpload: true },
        pairedAt: 1760000000000,
        lastSeen: 1760000000100
      });
      assert.strictEqual(storedAlpha.displayName, 'Alice workstation');
      assert.deepStrictEqual(storedAlpha.permissions, { transfer: true, libraryRead: true, libraryUpload: true });
      assert.strictEqual(storedAlpha.pairedAt, 1760000000000);
      assert.strictEqual(storedAlpha.lastSeen, 1760000000100);

      assert.strictEqual(store.markTrustedPeerSeen(alpha.deviceId, 1760000000200), true);
      const seenAlpha = store.getTrustedPeer(alpha.deviceId);
      assert.strictEqual(seenAlpha.lastSeen, 1760000000200);
      assert.ok(seenAlpha.updatedAt > storedAlpha.updatedAt);
      assert.strictEqual(store.markTrustedPeerSeen(alpha.deviceId, 1760000000199), false);
      assert.strictEqual(store.getTrustedPeer(alpha.deviceId).lastSeen, 1760000000200);

      const updatedAlpha = store.upsertTrustedPeer({
        identity: alpha,
        displayName: 'Primary workstation',
        permissions: { transfer: false },
        pairedAt: 1760000000300,
        lastSeen: 1760000000150
      });
      assert.strictEqual(updatedAlpha.displayName, 'Primary workstation');
      assert.strictEqual(updatedAlpha.lastSeen, 1760000000200, 'upsert must not move lastSeen backwards');
      assert.ok(updatedAlpha.updatedAt > seenAlpha.updatedAt);

      store.upsertTrustedPeer({ identity: bravo, permissions: { transfer: false } });
      assert.deepStrictEqual(
        store.listTrustedPeers().map((peer) => peer.identity.deviceId),
        [bravo.deviceId, alpha.deviceId]
      );
      assert.strictEqual(store.database.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
      assert.strictEqual(store.database.prepare('PRAGMA synchronous').get().synchronous, 2);
      assert.strictEqual(store.database.prepare('PRAGMA quick_check').get().quick_check, 'ok');
    });

    withTrustedPeerStore(tempDir, (store) => {
      assert.strictEqual(store.getTrustedPeer(alpha.deviceId).displayName, 'Primary workstation');
      assert.strictEqual(store.getTrustedPeer(alpha.deviceId).lastSeen, 1760000000200);
      assert.strictEqual(store.revokeTrustedPeer(alpha.deviceId, 1760000001000), true);
      assert.strictEqual(store.revokeTrustedPeer(alpha.deviceId, 1760000001001), false);
      assert.strictEqual(store.markTrustedPeerSeen(alpha.deviceId, 1760000001100), false);
      assert.strictEqual(store.getTrustedPeer(alpha.deviceId), null);
      assert.strictEqual(store.getTrustedPeer(alpha.deviceId, { includeRevoked: true }).revokedAt, 1760000001000);
      assert.strictEqual(store.listTrustedPeers().length, 1);
      assert.strictEqual(store.listTrustedPeers({ includeRevoked: true }).length, 2);
      assert.strictEqual(store.deleteTrustedPeer(alpha.deviceId), true);
      assert.strictEqual(store.deleteTrustedPeer(alpha.deviceId), false);
    });

    assert.strictEqual(fs.existsSync(path.join(tempDir, DATABASE_FILE)), true);
  });
}

function testIdentityChangeDetectionIsAtomic() {
  withTempDirectory('nearby-transfer-peer-identity-', (tempDir) => {
    withTrustedPeerStore(tempDir, (store) => {
      const identity = createIdentity('Stable peer');
      const original = store.upsertTrustedPeer({
        identity,
        displayName: 'Stable peer',
        pairedAt: 1760000010000,
        lastSeen: 1760000010000
      });
      const changedIdentity = {
        ...identity,
        encryptionPublicKey: createX25519KeyPair().publicKey
      };

      assert.throws(
        () => store.upsertTrustedPeer({
          identity: changedIdentity,
          displayName: 'Attacker-controlled name',
          permissions: { transfer: false },
          pairedAt: 1760000011000
        }),
        (error) => error.code === 'TRUSTED_PEER_IDENTITY_CHANGED' && error.changedFields.includes('encryption key')
      );
      assert.deepStrictEqual(store.getTrustedPeer(identity.deviceId), original);
      assert.strictEqual(store.database.prepare('PRAGMA quick_check').get().quick_check, 'ok');
    });
  });
}

function testManagedPeerUpdatesAreAtomicAndSafe() {
  withTempDirectory('nearby-transfer-peer-updates-', (tempDir) => {
    const identity = createIdentity('Managed peer');
    withTrustedPeerStore(tempDir, (store) => {
      const original = store.upsertTrustedPeer({
        identity,
        displayName: 'Original name',
        permissions: { transfer: false, libraryRead: true },
        pairedAt: 1760000015000,
        lastSeen: 1760000015000
      });

      const renamed = store.updateTrustedPeerDisplayName(identity.deviceId, ' Renamed peer ');
      assert.strictEqual(renamed.displayName, 'Renamed peer');
      assert.deepStrictEqual(renamed.permissions, original.permissions);
      assert.ok(renamed.updatedAt > original.updatedAt);

      const permissionsUpdated = store.updateTrustedPeerPermissions(identity.deviceId, { libraryUpload: true });
      assert.deepStrictEqual(permissionsUpdated.permissions, {
        transfer: false,
        libraryRead: true,
        libraryUpload: true
      });
      assert.ok(permissionsUpdated.updatedAt > renamed.updatedAt);

      const transferUpdated = store.updateTrustedPeerPermissions(identity.deviceId, { transfer: true });
      assert.strictEqual(transferUpdated.permissions.transfer, true);
      assert.strictEqual(transferUpdated.permissions.libraryRead, true);
      assert.strictEqual(transferUpdated.permissions.libraryUpload, true);

      const atomicUpdated = store.updateTrustedPeer(identity.deviceId, {
        displayName: 'Atomic peer',
        permissions: { transfer: false, libraryRead: true, libraryUpload: true }
      });
      assert.strictEqual(atomicUpdated.displayName, 'Atomic peer');
      assert.deepStrictEqual(atomicUpdated.permissions, {
        transfer: false,
        libraryRead: true,
        libraryUpload: true
      });
      assert.throws(
        () => store.updateTrustedPeer(identity.deviceId, {
          displayName: 'Should not persist',
          permissions: { libraryRead: false, libraryUpload: true }
        }),
        /requires library read/
      );
      assert.strictEqual(store.getTrustedPeer(identity.deviceId).displayName, 'Atomic peer');
      assert.throws(() => store.updateTrustedPeer(identity.deviceId, {}), /must contain a field/);

      assert.throws(
        () => store.updateTrustedPeerPermissions(identity.deviceId, { libraryRead: false }),
        /requires library read/
      );
      assert.deepStrictEqual(store.getTrustedPeer(identity.deviceId).permissions, atomicUpdated.permissions);

      assert.throws(
        () => store.updateTrustedPeerPermissions(identity.deviceId, { transfer: 'yes' }),
        /Invalid peer permission/
      );
      assert.throws(
        () => store.updateTrustedPeerDisplayName(identity.deviceId, '   '),
        /display name is invalid/
      );
      assert.throws(
        () => store.updateTrustedPeerDisplayName(identity.deviceId, 'x'.repeat(129)),
        /display name is invalid/
      );
      assert.strictEqual(store.updateTrustedPeerPermissions('abcdef0123456789', { transfer: false }), false);
      assert.strictEqual(store.updateTrustedPeerDisplayName('abcdef0123456789', 'Unused'), false);

      assert.strictEqual(store.revokeTrustedPeer(identity.deviceId, 1760000016000), true);
      assert.strictEqual(store.updateTrustedPeerPermissions(identity.deviceId, { transfer: false }), false);
      assert.strictEqual(store.updateTrustedPeerDisplayName(identity.deviceId, 'Revoked update'), false);
      assert.strictEqual(store.getTrustedPeer(identity.deviceId, { includeRevoked: true }).displayName, 'Atomic peer');
    });

    withTrustedPeerStore(tempDir, (store) => {
      const persisted = store.getTrustedPeer(identity.deviceId, { includeRevoked: true });
      assert.strictEqual(persisted.displayName, 'Atomic peer');
      assert.deepStrictEqual(persisted.permissions, {
        transfer: false,
        libraryRead: true,
        libraryUpload: true
      });
    });
  });
}

function testCorruptDatabaseRecovery() {
  withTempDirectory('nearby-transfer-peer-corrupt-', (tempDir) => {
    const databasePath = path.join(tempDir, DATABASE_FILE);
    const corruptBytes = Buffer.from('not a sqlite database\0preserve this evidence', 'utf8');
    fs.writeFileSync(databasePath, corruptBytes);

    withTrustedPeerStore(tempDir, (store) => {
      assert.ok(store.corruptDatabaseBackupPath, 'recovery should expose the quarantined database path');
      assert.strictEqual(fs.existsSync(store.corruptDatabaseBackupPath), true);
      assert.deepStrictEqual(fs.readFileSync(store.corruptDatabaseBackupPath), corruptBytes);
      assert.strictEqual(store.database.prepare('PRAGMA quick_check').get().quick_check, 'ok');

      const identity = createIdentity('Recovered peer');
      store.upsertTrustedPeer({ identity });
      assert.strictEqual(store.getTrustedPeer(identity.deviceId).identity.deviceId, identity.deviceId);
    });
  });
}

function testLegacySchemaMigration() {
  withTempDirectory('nearby-transfer-peer-migration-', (tempDir) => {
    const databasePath = path.join(tempDir, DATABASE_FILE);
    const identity = createIdentity('Legacy peer');
    const database = new DatabaseSync(databasePath);
    try {
      database.exec(`
        CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
        CREATE TABLE trusted_peers (
          device_id TEXT PRIMARY KEY,
          device_name TEXT NOT NULL,
          display_name TEXT NOT NULL,
          fingerprint TEXT NOT NULL,
          signing_public_key TEXT NOT NULL UNIQUE,
          encryption_public_key TEXT NOT NULL,
          transfer_allowed INTEGER NOT NULL,
          library_read_allowed INTEGER NOT NULL,
          library_upload_allowed INTEGER NOT NULL,
          paired_at INTEGER NOT NULL,
          revoked_at INTEGER,
          updated_at INTEGER NOT NULL
        );
      `);
      database.prepare(`
        INSERT INTO trusted_peers VALUES (?, ?, ?, ?, ?, ?, 1, 0, 0, ?, NULL, ?)
      `).run(
        identity.deviceId,
        identity.deviceName,
        identity.deviceName,
        identity.fingerprint,
        identity.signingPublicKey,
        identity.encryptionPublicKey,
        1760000020000,
        1760000020100
      );
    } finally {
      database.close();
    }

    withTrustedPeerStore(tempDir, (store) => {
      const migrated = store.getTrustedPeer(identity.deviceId);
      assert.strictEqual(migrated.lastSeen, 1760000020100);
      assert.strictEqual(
        store.database.prepare('SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 2').get().count,
        1
      );
    });
  });
}

function testInputValidation() {
  withTempDirectory('nearby-transfer-peer-validation-', (tempDir) => {
    withTrustedPeerStore(tempDir, (store) => {
      const identity = createIdentity('Validation peer');
      store.upsertTrustedPeer({ identity });

      assert.throws(() => store.getTrustedPeer(identity.deviceId, null), /Query options must be an object/);
      assert.throws(() => store.getTrustedPeer(identity.deviceId, { includeRevoked: 'yes' }), /must be a boolean/);
      assert.throws(() => store.listTrustedPeers({ unknown: true }), /Invalid query option/);
      assert.throws(() => store.revokeTrustedPeer('INVALID', 1760000030000), /Device ID/);
      assert.throws(() => store.revokeTrustedPeer(identity.deviceId, 0), /positive safe integer/);
      assert.throws(() => store.markTrustedPeerSeen(identity.deviceId, Number.NaN), /positive safe integer/);
      assert.throws(() => store.deleteTrustedPeer('ABCDEF0123456789'), /Device ID/);
      assert.throws(() => store.upsertTrustedPeer(null), /Trusted peer must be an object/);
      assert.throws(() => store.upsertTrustedPeer({ identity, unknown: true }), /Invalid trusted peer/);
      assert.throws(() => normalizePermissions({ libraryUpload: true }), /requires library read/);
      assert.throws(() => normalizePermissions({ unknown: true }), /Invalid peer permission/);
    });
  });
}

testPersistenceAndMetadata();
testIdentityChangeDetectionIsAtomic();
testManagedPeerUpdatesAreAtomicAndSafe();
testCorruptDatabaseRecovery();
testLegacySchemaMigration();
testInputValidation();
console.log('trusted peer store smoke tests passed');

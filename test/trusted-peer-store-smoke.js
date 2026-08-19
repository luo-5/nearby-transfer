'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
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

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nearby-transfer-peer-store-'));
try {
  const store = new TrustedPeerStore(tempDir);
  const alpha = createIdentity('Alpha laptop');
  const bravo = createIdentity('Bravo phone');

  const storedAlpha = store.upsertTrustedPeer({
    identity: alpha,
    displayName: 'Alice workstation',
    permissions: { transfer: true, libraryRead: true, libraryUpload: true },
    pairedAt: 1760000000000
  });
  assert.strictEqual(storedAlpha.displayName, 'Alice workstation');
  assert.deepStrictEqual(storedAlpha.permissions, { transfer: true, libraryRead: true, libraryUpload: true });
  assert.strictEqual(store.listTrustedPeers().length, 1);

  store.upsertTrustedPeer({ identity: bravo, permissions: { transfer: false } });
  assert.deepStrictEqual(
    store.listTrustedPeers().map((peer) => peer.identity.deviceId),
    [alpha.deviceId, bravo.deviceId]
  );

  assert.strictEqual(store.revokeTrustedPeer(alpha.deviceId, 1760000001000), true);
  assert.strictEqual(store.getTrustedPeer(alpha.deviceId), null);
  assert.strictEqual(store.getTrustedPeer(alpha.deviceId, { includeRevoked: true }).revokedAt, 1760000001000);
  assert.strictEqual(store.listTrustedPeers().length, 1);
  assert.strictEqual(store.deleteTrustedPeer(alpha.deviceId), true);
  assert.strictEqual(store.deleteTrustedPeer(alpha.deviceId), false);
  store.close();

  assert.strictEqual(fs.existsSync(path.join(tempDir, DATABASE_FILE)), true);
  assert.throws(() => normalizePermissions({ libraryUpload: true }), /requires library read/);
  assert.throws(() => normalizePermissions({ unknown: true }), /Invalid peer permission/);
  console.log('trusted peer store smoke tests passed');
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 3 });
}

'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createKeyPair, createX25519KeyPair, fingerprintFor } = require('../src/core/crypto');
const { createDesktopPairingApi, registerPairingIpcHandlers } = require('../src/v2/desktop-pairing-api');
const { PairingSessionStore } = require('../src/v2/pairing-session-store');
const { TrustedPeerStore } = require('../src/v2/trusted-peer-store');

function createDevice(name) {
  const signing = createKeyPair('ed25519');
  const encryption = createX25519KeyPair();
  return {
    deviceId: crypto.createHash('sha256').update(signing.publicKey).digest('hex').slice(0, 16),
    deviceName: name,
    fingerprint: fingerprintFor(signing.publicKey),
    signingPublicKey: signing.publicKey,
    signingPrivateKey: signing.privateKey,
    encryptionPublicKey: encryption.publicKey,
    encryptionPrivateKey: encryption.privateKey
  };
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nearby-transfer-desktop-api-'));
let peers;
let sessions;
try {
  const device = createDevice('Desktop test');
  peers = new TrustedPeerStore(dir);
  sessions = new PairingSessionStore(dir);
  peers.upsertTrustedPeer({ identity: createDevice('Trusted phone') });
  const api = createDesktopPairingApi({ device, trustedPeerStore: peers, pairingSessionStore: sessions });

  const handlers = new Map();
  registerPairingIpcHandlers({ handle: (channel, handler) => handlers.set(channel, handler) }, api);
  assert.deepStrictEqual(Array.from(handlers.keys()).sort(), [
    'v2:list-pairing-sessions',
    'v2:list-trusted-peers'
  ]);

  const visiblePeers = handlers.get('v2:list-trusted-peers')();
  assert.strictEqual(visiblePeers.length, 1);
  assert.strictEqual(Object.hasOwn(visiblePeers[0], 'signingPublicKey'), false);

  assert.strictEqual(handlers.has('v2:start-pairing'), false);
  assert.strictEqual(handlers.has('v2:confirm-pairing'), false);
  assert.strictEqual(handlers.has('v2:cancel-pairing'), false);
  console.log('desktop pairing API smoke tests passed');
} finally {
  if (sessions) sessions.close();
  if (peers) peers.close();
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
}

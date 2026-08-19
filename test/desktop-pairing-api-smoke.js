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
    'v2:cancel-pairing',
    'v2:confirm-pairing',
    'v2:list-pairing-sessions',
    'v2:list-trusted-peers',
    'v2:start-pairing'
  ]);

  const visiblePeers = handlers.get('v2:list-trusted-peers')();
  assert.strictEqual(visiblePeers.length, 1);
  assert.strictEqual(Object.hasOwn(visiblePeers[0], 'signingPublicKey'), false);

  const started = handlers.get('v2:start-pairing')(null, { capabilities: ['transfer'] });
  assert.match(started.session.pairingId, /^[A-Za-z0-9_-]{22}$/);
  assert.strictEqual(started.session.pairingCode, null);
  assert.strictEqual(Object.hasOwn(started.outboundOffer.offer, 'signingPrivateKey'), false);
  assert.strictEqual(handlers.get('v2:cancel-pairing')(null, started.session.pairingId), true);
  assert.deepStrictEqual(handlers.get('v2:list-pairing-sessions')(), []);
  console.log('desktop pairing API smoke tests passed');
} finally {
  if (sessions) sessions.close();
  if (peers) peers.close();
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
}

'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createKeyPair, createX25519KeyPair, fingerprintFor } = require('../src/core/crypto');
const { PairingSessionStore, SESSION_STATUS, PAIRING_SESSION_TTL_MS } = require('../src/v2/pairing-session-store');
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

const now = 1760000000000;
const aliceDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'nearby-transfer-pairing-alice-'));
const bobDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'nearby-transfer-pairing-bob-'));
let aliceSessions;
let bobSessions;
let alicePeers;
try {
  const alice = createDevice('Alice Windows');
  const bob = createDevice('Bob Android');
  aliceSessions = new PairingSessionStore(aliceDirectory);
  bobSessions = new PairingSessionStore(bobDirectory);
  alicePeers = new TrustedPeerStore(aliceDirectory);

  const started = aliceSessions.startOutgoing({
    localDevice: alice,
    localPrivateKey: alice.signingPrivateKey,
    capabilities: ['transfer'],
    now
  });
  assert.strictEqual(started.session.status, SESSION_STATUS.AWAITING_REMOTE_OFFER);

  const inbound = bobSessions.receiveIncomingOffer({
    offer: started.offer,
    signature: started.signature,
    localDevice: bob,
    now: now + 1
  });
  assert.strictEqual(inbound.status, SESSION_STATUS.AWAITING_LOCAL_CONFIRMATION);

  const bobResponse = bobSessions.respondToIncomingOffer(started.offer.pairingId, {
    localDevice: bob,
    localPrivateKey: bob.signingPrivateKey,
    capabilities: ['transfer'],
    now: now + 2
  });
  assert.strictEqual(bobResponse.offer.pairingId, started.offer.pairingId);
  const outbound = aliceSessions.receiveRemoteOffer({
    pairingId: started.offer.pairingId,
    offer: bobResponse.offer,
    signature: bobResponse.signature,
    localDevice: alice,
    now: now + 3
  });
  assert.strictEqual(outbound.pairingCode, inbound.pairingCode);

  const aliceConfirmation = aliceSessions.createLocalConfirmation(started.offer.pairingId, {
    localDevice: alice,
    localPrivateKey: alice.signingPrivateKey,
    now: now + 4
  });
  assert.strictEqual(aliceConfirmation.session.status, SESSION_STATUS.AWAITING_REMOTE_CONFIRMATION);
  assert.throws(() => bobSessions.receiveRemoteConfirmation({
    pairingId: started.offer.pairingId,
    confirmation: aliceConfirmation.confirmation,
    signature: 'not-a-signature',
    now: now + 5
  }), /signature|code/);
  assert.strictEqual(bobSessions.receiveRemoteConfirmation({
    pairingId: started.offer.pairingId,
    confirmation: aliceConfirmation.confirmation,
    signature: aliceConfirmation.signature,
    now: now + 5
  }).status, SESSION_STATUS.AWAITING_LOCAL_CONFIRMATION);

  const bobConfirmation = bobSessions.createLocalConfirmation(started.offer.pairingId, {
    localDevice: bob,
    localPrivateKey: bob.signingPrivateKey,
    now: now + 6
  });
  assert.strictEqual(bobConfirmation.session.status, SESSION_STATUS.READY_TO_TRUST);
  assert.strictEqual(aliceSessions.receiveRemoteConfirmation({
    pairingId: started.offer.pairingId,
    confirmation: bobConfirmation.confirmation,
    signature: bobConfirmation.signature,
    now: now + 7
  }).status, SESSION_STATUS.READY_TO_TRUST);
  assert.strictEqual(aliceSessions.get(started.offer.pairingId).status, SESSION_STATUS.READY_TO_TRUST);
  assert.strictEqual(bobSessions.get(started.offer.pairingId).status, SESSION_STATUS.READY_TO_TRUST);

  const trustedBob = aliceSessions.complete(started.offer.pairingId, alicePeers, {
    permissions: { transfer: true, libraryRead: true, libraryUpload: false },
    now: now + 8
  });
  assert.strictEqual(trustedBob.identity.deviceId, bob.deviceId);
  assert.strictEqual(alicePeers.getTrustedPeer(bob.deviceId).permissions.libraryRead, true);
  assert.strictEqual(aliceSessions.get(started.offer.pairingId), null);
  assert.strictEqual(aliceSessions.get(started.offer.pairingId, { includeTerminal: true }).status, SESSION_STATUS.COMPLETED);

  const expired = aliceSessions.startOutgoing({ localDevice: alice, localPrivateKey: alice.signingPrivateKey, now: now + 10 });
  assert.strictEqual(
    aliceSessions.get(expired.offer.pairingId, { includeTerminal: true }).status,
    SESSION_STATUS.AWAITING_REMOTE_OFFER
  );
  assert.deepStrictEqual(aliceSessions.listActive(now + 10 + PAIRING_SESSION_TTL_MS + 1), []);
  assert.strictEqual(
    aliceSessions.get(expired.offer.pairingId, { includeTerminal: true }).status,
    SESSION_STATUS.EXPIRED
  );

  assert.throws(() => bobSessions.receiveIncomingOffer({
    offer: started.offer,
    signature: 'not-a-signature',
    localDevice: bob,
    now: now + 10
  }), /signature/);
  console.log('pairing session store smoke tests passed');
} finally {
  if (alicePeers) alicePeers.close();
  if (aliceSessions) aliceSessions.close();
  if (bobSessions) bobSessions.close();
  fs.rmSync(aliceDirectory, { recursive: true, force: true, maxRetries: 3 });
  fs.rmSync(bobDirectory, { recursive: true, force: true, maxRetries: 3 });
}

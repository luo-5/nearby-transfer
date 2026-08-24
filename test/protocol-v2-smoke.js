'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { canonicalJson } = require('../src/v2/canonical-json');
const {
  assertValidPairingOffer,
  assertValidPairingConfirmation,
  createPairingOffer,
  createPairingConfirmation,
  createPairingCancel,
  derivePairingCode,
  pairingCodeTranscript,
  signPairingOffer,
  signPairingConfirmation,
  signPairingCancel,
  verifyPairingOffer,
  verifyPairingConfirmation,
  verifyPairingCancel
} = require('../src/v2/pairing');
const { createKeyPair, createX25519KeyPair, fingerprintFor } = require('../src/core/crypto');

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

function testCanonicalJson() {
  assert.strictEqual(
    canonicalJson({ zebra: [true, null, '你好'], alpha: { second: 2, first: 1 } }),
    '{"alpha":{"first":1,"second":2},"zebra":[true,null,"你好"]}'
  );
  assert.throws(() => canonicalJson({ decimal: 1.5 }), /safe integer/);
  assert.throws(() => canonicalJson({ missing: undefined }), /undefined/i);
  assert.throws(() => canonicalJson({ malformed: '\ud800' }), /unpaired surrogate/);
}

function testPairingVector() {
  const fixturePath = path.join(__dirname, 'fixtures', 'protocol-v2-pairing.json');
  const vector = JSON.parse(fs.readFileSync(fixturePath, 'utf8')).pairingCode;
  const context = {
    pairingId: vector.pairingId,
    initiator: vector.initiator,
    responder: vector.responder
  };
  assert.strictEqual(pairingCodeTranscript(context), vector.expectedTranscript);
  assert.strictEqual(derivePairingCode(context), vector.expectedCode);
  assert.match(vector.expectedCode, /^\d{6}$/);
}

function testSignedPairingOfferAndConfirmation() {
  const sender = createDevice('Windows workstation');
  const offer = createPairingOffer({
    device: sender,
    pairingId: 'AQIDBAUGBwgJCgsMDQ4PEA',
    issuedAt: 1760000000000,
    capabilities: ['file-library', 'transfer']
  });
  const signature = signPairingOffer(offer, sender.signingPrivateKey);
  assert.strictEqual(verifyPairingOffer(offer, signature), true);

  const altered = Object.assign({}, offer, { capabilities: ['transfer'] });
  assert.strictEqual(verifyPairingOffer(altered, signature), false);
  assert.throws(() => assertValidPairingOffer(Object.assign({}, offer, { pairingId: 'short' })), /Pairing ID/);
  assert.throws(() => createPairingOffer({ device: sender, capabilities: ['transfer', 'transfer'] }), /duplicates/);

  const confirmation = createPairingConfirmation({
    pairingId: offer.pairingId,
    device: sender,
    pairingCode: '042069',
    issuedAt: offer.issuedAt + 1
  });
  const confirmationSignature = signPairingConfirmation(confirmation, sender.signingPrivateKey);
  assert.strictEqual(verifyPairingConfirmation(confirmation, confirmationSignature, sender.signingPublicKey), true);
  assert.strictEqual(verifyPairingConfirmation(
    Object.assign({}, confirmation, { pairingCode: '042070' }),
    confirmationSignature,
    sender.signingPublicKey
  ), false);
  assert.throws(() => assertValidPairingConfirmation(Object.assign({}, confirmation, { pairingCode: '42069' })), /code/);

  const cancellation = createPairingCancel({
    pairingId: offer.pairingId,
    device: sender,
    reason: 'user-cancelled',
    issuedAt: offer.issuedAt + 2
  });
  const cancellationSignature = signPairingCancel(cancellation, sender.signingPrivateKey);
  assert.strictEqual(verifyPairingCancel(cancellation, cancellationSignature, sender.signingPublicKey), true);
  assert.strictEqual(verifyPairingCancel(
    Object.assign({}, cancellation, { reason: 'timeout' }),
    cancellationSignature,
    sender.signingPublicKey
  ), false);
}


testCanonicalJson();
testPairingVector();
testSignedPairingOfferAndConfirmation();
console.log('protocol v2 smoke tests passed');

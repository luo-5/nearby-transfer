'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { canonicalJson } = require('../src/v2/canonical-json');
const {
  assertValidPairingOffer,
  createPairingOffer,
  derivePairingCode,
  pairingCodeTranscript,
  signPairingOffer,
  verifyPairingOffer
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
  assert.throws(() => canonicalJson({ missing: undefined }), /unsupported type/);
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

function testSignedPairingOffer() {
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
}

testCanonicalJson();
testPairingVector();
testSignedPairingOffer();
console.log('protocol v2 smoke tests passed');

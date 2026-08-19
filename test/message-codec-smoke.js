'use strict';

const assert = require('assert');
const crypto = require('crypto');
const { createKeyPair, createX25519KeyPair, fingerprintFor } = require('../src/core/crypto');
const { createPairingOffer, signPairingOffer, createPairingConfirmation, signPairingConfirmation, createPairingCancel, signPairingCancel } = require('../src/v2/pairing');
const { MESSAGE_TYPES } = require('../src/v2/constants');
const { encodeControlMessage, decodeControlMessage } = require('../src/v2/message-codec');

function createDevice(name) {
  const signing = createKeyPair('ed25519');
  const encryption = createX25519KeyPair();
  return {
    deviceId: crypto.createHash('sha256').update(signing.publicKey).digest('hex').slice(0, 16),
    deviceName: name,
    fingerprint: fingerprintFor(signing.publicKey),
    signingPublicKey: signing.publicKey,
    signingPrivateKey: signing.privateKey,
    encryptionPublicKey: encryption.publicKey
  };
}

const sender = createDevice('Codec Sender');
const pairingId = 'AQIDBAUGBwgJCgsMDQ4PEA';
const offer = createPairingOffer({ device: sender, pairingId, issuedAt: 1760000000000, capabilities: ['pairing'] });
const offerMessage = { offer, signature: signPairingOffer(offer, sender.signingPrivateKey) };
const offerBytes = encodeControlMessage(MESSAGE_TYPES.PAIRING_OFFER, offerMessage);
assert.deepStrictEqual(decodeControlMessage(MESSAGE_TYPES.PAIRING_OFFER, offerBytes), offerMessage);

const confirmation = createPairingConfirmation({ pairingId, device: sender, pairingCode: '123456', issuedAt: 1760000000010 });
const confirmationMessage = { confirmation, signature: signPairingConfirmation(confirmation, sender.signingPrivateKey) };
assert.deepStrictEqual(decodeControlMessage(MESSAGE_TYPES.PAIRING_CONFIRM, encodeControlMessage(MESSAGE_TYPES.PAIRING_CONFIRM, confirmationMessage)), confirmationMessage);

const cancellation = createPairingCancel({ pairingId, device: sender, issuedAt: 1760000000020 });
const cancellationMessage = { cancellation, signature: signPairingCancel(cancellation, sender.signingPrivateKey) };
assert.deepStrictEqual(decodeControlMessage(MESSAGE_TYPES.PAIRING_CANCEL, encodeControlMessage(MESSAGE_TYPES.PAIRING_CANCEL, cancellationMessage)), cancellationMessage);
assert.throws(() => decodeControlMessage(MESSAGE_TYPES.PAIRING_OFFER, Buffer.from('{"signature":"x","offer":{}}')), /canonical|unsupported|Pairing/);
assert.throws(() => encodeControlMessage(MESSAGE_TYPES.PAIRING_OFFER, { ...offerMessage, ignored: true }), /unknown/);
assert.throws(() => decodeControlMessage(MESSAGE_TYPES.PAIRING_CONFIRM, offerBytes), /Pairing confirmation/);
assert.throws(() => decodeControlMessage('transfer-manifest', Buffer.from('{}')), /Unsupported/);
console.log('message codec smoke tests passed');
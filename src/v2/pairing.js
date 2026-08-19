'use strict';

const crypto = require('crypto');
const {
  APP_ID,
  PROTOCOL_VERSION,
  PAIRING_CODE_DIGITS,
  PAIRING_ID_BYTES,
  MAX_DEVICE_NAME_LENGTH,
  MAX_PUBLIC_KEY_LENGTH,
  MAX_CAPABILITIES,
  MAX_CAPABILITY_LENGTH,
  MESSAGE_TYPES
} = require('./constants');
const { canonicalJson } = require('./canonical-json');
const { fingerprintFor } = require('../core/crypto');

const DEVICE_ID_PATTERN = /^[a-f0-9]{16}$/;
const PAIRING_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const CAPABILITY_PATTERN = /^[a-z][a-z0-9-]*$/;
const PAIRING_CODE_PATTERN = /^[0-9]{6}$/;
const PAIRING_CODE_DOMAIN = 'nearby-transfer/v2/pairing-code\0';
const PAIRING_CANCEL_REASONS = new Set(['connection-closed', 'rejected', 'timeout', 'user-cancelled']);

function publicIdentity(device) {
  return {
    deviceId: device && device.deviceId,
    deviceName: device && device.deviceName,
    fingerprint: device && device.fingerprint,
    signingPublicKey: device && device.signingPublicKey,
    encryptionPublicKey: device && device.encryptionPublicKey
  };
}

function assertValidPublicIdentity(identity) {
  if (!identity || typeof identity !== 'object' || Array.isArray(identity)) {
    throw new TypeError('Identity must be an object');
  }

  const normalized = publicIdentity(identity);
  if (!DEVICE_ID_PATTERN.test(normalized.deviceId || '')) {
    throw new TypeError('Identity device ID must be 16 lowercase hexadecimal characters');
  }
  if (!isBoundedText(normalized.deviceName, MAX_DEVICE_NAME_LENGTH)) {
    throw new TypeError('Identity device name is invalid');
  }
  if (!isBoundedText(normalized.signingPublicKey, MAX_PUBLIC_KEY_LENGTH) ||
      !isBoundedText(normalized.encryptionPublicKey, MAX_PUBLIC_KEY_LENGTH)) {
    throw new TypeError('Identity public key is invalid');
  }
  if (!/^[0-9A-F]{4}(?:-[0-9A-F]{4}){5}$/.test(normalized.fingerprint || '')) {
    throw new TypeError('Identity fingerprint is invalid');
  }

  let signingKey;
  let encryptionKey;
  try {
    signingKey = crypto.createPublicKey(normalized.signingPublicKey);
    encryptionKey = crypto.createPublicKey(normalized.encryptionPublicKey);
  } catch (_error) {
    throw new TypeError('Identity contains an unreadable public key');
  }
  if (signingKey.asymmetricKeyType !== 'ed25519' || encryptionKey.asymmetricKeyType !== 'x25519') {
    throw new TypeError('Identity contains unexpected public key types');
  }

  const expectedDeviceId = crypto.createHash('sha256')
    .update(normalized.signingPublicKey)
    .digest('hex')
    .slice(0, 16);
  if (normalized.deviceId !== expectedDeviceId || normalized.fingerprint !== fingerprintFor(normalized.signingPublicKey)) {
    throw new TypeError('Identity metadata does not match signing public key');
  }
  return normalized;
}

function createPairingOffer({ device, capabilities = [], pairingId = createPairingId(), issuedAt = Date.now() }) {
  const offer = {
    app: APP_ID,
    protocolVersion: PROTOCOL_VERSION,
    type: MESSAGE_TYPES.PAIRING_OFFER,
    pairingId,
    issuedAt,
    identity: publicIdentity(device),
    capabilities: normalizeCapabilities(capabilities)
  };
  assertValidPairingOffer(offer);
  return offer;
}

function createPairingConfirmation({ pairingId, device, pairingCode, issuedAt = Date.now() }) {
  const confirmation = {
    app: APP_ID,
    protocolVersion: PROTOCOL_VERSION,
    type: MESSAGE_TYPES.PAIRING_CONFIRM,
    pairingId,
    issuedAt,
    deviceId: publicIdentity(device).deviceId,
    pairingCode
  };
  assertValidPairingConfirmation(confirmation);
  return confirmation;
}

function createPairingCancel({ pairingId, device, reason = 'user-cancelled', issuedAt = Date.now() }) {
  const cancellation = {
    app: APP_ID,
    protocolVersion: PROTOCOL_VERSION,
    type: MESSAGE_TYPES.PAIRING_CANCEL,
    pairingId,
    issuedAt,
    deviceId: publicIdentity(device).deviceId,
    reason
  };
  assertValidPairingCancel(cancellation);
  return cancellation;
}

function signPairingOffer(offer, privateKeyPem) {
  assertValidPairingOffer(offer);
  return crypto.sign(
    null,
    Buffer.from(pairingOfferSigningPayload(offer), 'utf8'),
    crypto.createPrivateKey(privateKeyPem)
  ).toString('base64');
}

function verifyPairingOffer(offer, signature) {
  try {
    assertValidPairingOffer(offer);
    return verifySignedPayload(pairingOfferSigningPayload(offer), signature, offer.identity.signingPublicKey);
  } catch (_error) {
    return false;
  }
}

function signPairingConfirmation(confirmation, privateKeyPem) {
  assertValidPairingConfirmation(confirmation);
  return crypto.sign(
    null,
    Buffer.from(pairingConfirmationSigningPayload(confirmation), 'utf8'),
    crypto.createPrivateKey(privateKeyPem)
  ).toString('base64');
}

function verifyPairingConfirmation(confirmation, signature, signingPublicKey) {
  try {
    assertValidPairingConfirmation(confirmation);
    return verifySignedPayload(pairingConfirmationSigningPayload(confirmation), signature, signingPublicKey);
  } catch (_error) {
    return false;
  }
}

function signPairingCancel(cancellation, privateKeyPem) {
  assertValidPairingCancel(cancellation);
  return crypto.sign(
    null,
    Buffer.from(pairingCancelSigningPayload(cancellation), 'utf8'),
    crypto.createPrivateKey(privateKeyPem)
  ).toString('base64');
}

function verifyPairingCancel(cancellation, signature, signingPublicKey) {
  try {
    assertValidPairingCancel(cancellation);
    return verifySignedPayload(pairingCancelSigningPayload(cancellation), signature, signingPublicKey);
  } catch (_error) {
    return false;
  }
}

function assertValidPairingOffer(offer) {
  if (!offer || typeof offer !== 'object' || Array.isArray(offer)) {
    throw new TypeError('Pairing offer must be an object');
  }
  if (offer.app !== APP_ID || offer.protocolVersion !== PROTOCOL_VERSION || offer.type !== MESSAGE_TYPES.PAIRING_OFFER) {
    throw new TypeError('Pairing offer has an unsupported protocol envelope');
  }
  if (!PAIRING_ID_PATTERN.test(offer.pairingId || '')) {
    throw new TypeError('Pairing ID must be a 16-byte base64url value');
  }
  if (!Number.isSafeInteger(offer.issuedAt) || offer.issuedAt <= 0) {
    throw new TypeError('Pairing offer issue time must be a positive safe integer');
  }
  assertValidPublicIdentity(offer.identity);
  normalizeCapabilities(offer.capabilities);
  return offer;
}

function assertValidPairingConfirmation(confirmation) {
  if (!confirmation || typeof confirmation !== 'object' || Array.isArray(confirmation)) {
    throw new TypeError('Pairing confirmation must be an object');
  }
  if (confirmation.app !== APP_ID || confirmation.protocolVersion !== PROTOCOL_VERSION || confirmation.type !== MESSAGE_TYPES.PAIRING_CONFIRM) {
    throw new TypeError('Pairing confirmation has an unsupported protocol envelope');
  }
  if (!PAIRING_ID_PATTERN.test(confirmation.pairingId || '')) {
    throw new TypeError('Pairing ID must be a 16-byte base64url value');
  }
  if (!Number.isSafeInteger(confirmation.issuedAt) || confirmation.issuedAt <= 0) {
    throw new TypeError('Pairing confirmation issue time must be a positive safe integer');
  }
  if (!DEVICE_ID_PATTERN.test(confirmation.deviceId || '')) {
    throw new TypeError('Pairing confirmation device ID is invalid');
  }
  if (typeof confirmation.pairingCode !== 'string' || confirmation.pairingCode.length !== PAIRING_CODE_DIGITS || !PAIRING_CODE_PATTERN.test(confirmation.pairingCode)) {
    throw new TypeError('Pairing confirmation code is invalid');
  }
  return confirmation;
}

function assertValidPairingCancel(cancellation) {
  if (!cancellation || typeof cancellation !== 'object' || Array.isArray(cancellation)) {
    throw new TypeError('Pairing cancellation must be an object');
  }
  if (cancellation.app !== APP_ID || cancellation.protocolVersion !== PROTOCOL_VERSION || cancellation.type !== MESSAGE_TYPES.PAIRING_CANCEL) {
    throw new TypeError('Pairing cancellation has an unsupported protocol envelope');
  }
  if (!PAIRING_ID_PATTERN.test(cancellation.pairingId || '')) {
    throw new TypeError('Pairing ID must be a 16-byte base64url value');
  }
  if (!Number.isSafeInteger(cancellation.issuedAt) || cancellation.issuedAt <= 0) {
    throw new TypeError('Pairing cancellation issue time must be a positive safe integer');
  }
  if (!DEVICE_ID_PATTERN.test(cancellation.deviceId || '')) {
    throw new TypeError('Pairing cancellation device ID is invalid');
  }
  if (typeof cancellation.reason !== 'string' || !PAIRING_CANCEL_REASONS.has(cancellation.reason)) {
    throw new TypeError('Pairing cancellation reason is invalid');
  }
  return cancellation;
}

function pairingOfferSigningPayload(offer) {
  assertValidPairingOffer(offer);
  return canonicalJson({
    app: offer.app,
    protocolVersion: offer.protocolVersion,
    type: offer.type,
    pairingId: offer.pairingId,
    issuedAt: offer.issuedAt,
    identity: publicIdentity(offer.identity),
    capabilities: normalizeCapabilities(offer.capabilities)
  });
}

function pairingConfirmationSigningPayload(confirmation) {
  assertValidPairingConfirmation(confirmation);
  return canonicalJson({
    app: confirmation.app,
    protocolVersion: confirmation.protocolVersion,
    type: confirmation.type,
    pairingId: confirmation.pairingId,
    issuedAt: confirmation.issuedAt,
    deviceId: confirmation.deviceId,
    pairingCode: confirmation.pairingCode
  });
}

function pairingCancelSigningPayload(cancellation) {
  assertValidPairingCancel(cancellation);
  return canonicalJson({
    app: cancellation.app,
    protocolVersion: cancellation.protocolVersion,
    type: cancellation.type,
    pairingId: cancellation.pairingId,
    issuedAt: cancellation.issuedAt,
    deviceId: cancellation.deviceId,
    reason: cancellation.reason
  });
}

function pairingCodeTranscript({ pairingId, initiator, responder }) {
  if (!PAIRING_ID_PATTERN.test(pairingId || '')) {
    throw new TypeError('Pairing ID must be a 16-byte base64url value');
  }
  return canonicalJson({
    app: APP_ID,
    protocolVersion: PROTOCOL_VERSION,
    type: 'pairing-code',
    pairingId,
    initiator: assertValidPublicIdentity(initiator),
    responder: assertValidPublicIdentity(responder)
  });
}

function derivePairingCode(context) {
  const hash = crypto.createHash('sha256')
    .update(PAIRING_CODE_DOMAIN, 'utf8')
    .update(pairingCodeTranscript(context), 'utf8')
    .digest();
  const code = hash.readUInt32BE(0) % (10 ** PAIRING_CODE_DIGITS);
  return String(code).padStart(PAIRING_CODE_DIGITS, '0');
}

function createPairingId() {
  return crypto.randomBytes(PAIRING_ID_BYTES).toString('base64url');
}

function normalizeCapabilities(capabilities) {
  if (!Array.isArray(capabilities) || capabilities.length > MAX_CAPABILITIES) {
    throw new TypeError('Capabilities must be a bounded array');
  }
  const normalized = capabilities.map((capability) => {
    if (typeof capability !== 'string' || capability.length === 0 || capability.length > MAX_CAPABILITY_LENGTH || !CAPABILITY_PATTERN.test(capability)) {
      throw new TypeError('Capability is invalid');
    }
    return capability;
  });
  if (new Set(normalized).size !== normalized.length) {
    throw new TypeError('Capabilities must not contain duplicates');
  }
  return normalized.slice().sort();
}

function verifySignedPayload(payload, signature, signingPublicKey) {
  if (typeof signature !== 'string' || signature.length === 0 || signature.length > 512 ||
      typeof signingPublicKey !== 'string' || signingPublicKey.length === 0 || signingPublicKey.length > MAX_PUBLIC_KEY_LENGTH) {
    return false;
  }
  const key = crypto.createPublicKey(signingPublicKey);
  if (key.asymmetricKeyType !== 'ed25519') {
    return false;
  }
  return crypto.verify(null, Buffer.from(payload, 'utf8'), key, Buffer.from(signature, 'base64'));
}

function isBoundedText(value, maxLength) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength;
}

module.exports = {
  assertValidPublicIdentity,
  assertValidPairingOffer,
  assertValidPairingConfirmation,
  assertValidPairingCancel,
  createPairingId,
  createPairingOffer,
  createPairingConfirmation,
  createPairingCancel,
  derivePairingCode,
  pairingCodeTranscript,
  pairingOfferSigningPayload,
  pairingConfirmationSigningPayload,
  pairingCancelSigningPayload,
  publicIdentity,
  signPairingOffer,
  signPairingConfirmation,
  signPairingCancel,
  verifyPairingOffer,
  verifyPairingConfirmation,
  verifyPairingCancel
};
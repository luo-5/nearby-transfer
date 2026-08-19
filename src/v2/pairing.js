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
const PAIRING_CODE_DOMAIN = 'nearby-transfer/v2/pairing-code\0';

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
    if (typeof signature !== 'string' || signature.length === 0 || signature.length > 512) {
      return false;
    }
    return crypto.verify(
      null,
      Buffer.from(pairingOfferSigningPayload(offer), 'utf8'),
      crypto.createPublicKey(offer.identity.signingPublicKey),
      Buffer.from(signature, 'base64')
    );
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

function isBoundedText(value, maxLength) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength;
}

module.exports = {
  assertValidPublicIdentity,
  assertValidPairingOffer,
  createPairingId,
  createPairingOffer,
  derivePairingCode,
  pairingCodeTranscript,
  pairingOfferSigningPayload,
  publicIdentity,
  signPairingOffer,
  verifyPairingOffer
};

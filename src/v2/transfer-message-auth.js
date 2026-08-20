'use strict';

const crypto = require('crypto');
const { MAX_PUBLIC_KEY_LENGTH } = require('./constants');
const {
  TYPE_TRANSFER_COMPLETE,
  TYPE_TRANSFER_DECISION,
  TYPE_TRANSFER_MANIFEST,
  TYPE_TRANSFER_PROGRESS,
  TYPE_TRANSFER_RESUME,
  encodeTransferMessage,
  transferMessageSigningPayload,
  validateTransferMessage
} = require('./transfer-message-codec');

const SIGNATURE_BYTES = 64;
const SIGNATURE_PLACEHOLDER = Buffer.alloc(SIGNATURE_BYTES).toString('base64url');
const TRANSFER_TYPES = new Set([
  TYPE_TRANSFER_MANIFEST,
  TYPE_TRANSFER_DECISION,
  TYPE_TRANSFER_COMPLETE,
  TYPE_TRANSFER_RESUME,
  TYPE_TRANSFER_PROGRESS
]);

function signTransferMessage(type, unsignedMessage, signingPrivateKeyPem, options = {}) {
  assertInvocation(type, options);
  assertUnsignedMessage(unsignedMessage);

  const normalizedPlaceholder = validateTransferMessage(type, {
    ...unsignedMessage,
    signature: SIGNATURE_PLACEHOLDER
  }, options);
  encodeTransferMessage(type, normalizedPlaceholder, options);

  const normalizedUnsigned = { ...normalizedPlaceholder };
  delete normalizedUnsigned.signature;
  const signingPayload = transferMessageSigningPayload(type, normalizedUnsigned);
  const signingKey = readEd25519PrivateKey(signingPrivateKeyPem);
  const signatureBytes = crypto.sign(null, Buffer.from(signingPayload, 'utf8'), signingKey);
  if (signatureBytes.length !== SIGNATURE_BYTES) {
    throw new Error('Ed25519 produced an unexpected signature length');
  }

  const normalized = validateTransferMessage(type, {
    ...normalizedUnsigned,
    signature: signatureBytes.toString('base64url')
  }, options);
  encodeTransferMessage(type, normalized, options);
  return normalized;
}

function verifyTransferMessage(type, signedMessage, signingPublicKeyPem, options = {}) {
  assertInvocation(type, options);

  try {
    const normalized = validateTransferMessage(type, signedMessage, options);
    encodeTransferMessage(type, normalized, options);
    const signingKey = readEd25519PublicKey(signingPublicKeyPem);
    if (signingKey === null) return false;

    const signature = Buffer.from(normalized.signature, 'base64url');
    return crypto.verify(
      null,
      Buffer.from(transferMessageSigningPayload(type, normalized), 'utf8'),
      signingKey,
      signature
    );
  } catch (_error) {
    return false;
  }
}

function assertInvocation(type, options) {
  if (typeof type !== 'string' || !TRANSFER_TYPES.has(type)) {
    throw new TypeError('Unsupported transfer message type');
  }
  if (!isPlainObject(options)) {
    throw new TypeError('Transfer message authentication options must be a plain object');
  }
  if (Object.hasOwn(options, 'previous')) {
    throw new TypeError('Transfer control validation requires a complete checkpoint, not options.previous');
  }
  if (Object.hasOwn(options, 'now') &&
      (!Number.isSafeInteger(options.now) || options.now <= 0)) {
    throw new TypeError('Transfer message validation time must be a positive safe integer');
  }
}

function assertUnsignedMessage(message) {
  if (!isPlainObject(message)) {
    throw new TypeError('Unsigned transfer message must be a plain object');
  }
  if (Object.hasOwn(message, 'signature')) {
    throw new TypeError('Unsigned transfer message must not contain a signature');
  }
}

function readEd25519PrivateKey(pem) {
  assertBoundedPem(pem, 'PRIVATE KEY', 'Transfer signing private key');
  let key;
  try {
    key = crypto.createPrivateKey(pem);
  } catch (error) {
    throw new TypeError('Transfer signing private key is unreadable', { cause: error });
  }
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new TypeError('Transfer signing private key must be Ed25519');
  }
  return key;
}

function readEd25519PublicKey(pem) {
  try {
    assertBoundedPem(pem, 'PUBLIC KEY', 'Transfer signing public key');
    const key = crypto.createPublicKey(pem);
    return key.asymmetricKeyType === 'ed25519' ? key : null;
  } catch (_error) {
    return null;
  }
}

function assertBoundedPem(pem, label, subject) {
  if (typeof pem !== 'string' || pem.length === 0 ||
      pem.length > MAX_PUBLIC_KEY_LENGTH || pem.includes('\0')) {
    throw new TypeError(`${subject} must be bounded PEM text`);
  }
  const normalized = pem.replace(/\r\n/g, '\n');
  if (normalized.includes('\r') ||
      !normalized.startsWith(`-----BEGIN ${label}-----\n`) ||
      (!normalized.endsWith(`\n-----END ${label}-----`) &&
       !normalized.endsWith(`\n-----END ${label}-----\n`))) {
    throw new TypeError(`${subject} must use ${label} PEM framing`);
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

module.exports = {
  signTransferMessage,
  verifyTransferMessage
};

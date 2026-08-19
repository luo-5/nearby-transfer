'use strict';

const { TextDecoder } = require('util');
const { APP_ID, PROTOCOL_VERSION, MESSAGE_TYPES } = require('./constants');
const { canonicalJson, parseCanonicalJson } = require('./canonical-json');
const { assertValidTaskId, normalizeTransferManifest } = require('./transfer-manifest');

const TYPE_TRANSFER_MANIFEST = MESSAGE_TYPES.TRANSFER_MANIFEST;
const TYPE_TRANSFER_DECISION = 'transfer-decision';
const TYPE_TRANSFER_COMPLETE = MESSAGE_TYPES.TRANSFER_COMPLETE;
const MAX_TRANSFER_MESSAGE_BYTES = 4 * 1024 * 1024;
const MAX_MESSAGE_TTL_MS = 5 * 60 * 1000;
const MAX_CLOCK_SKEW_MS = 30 * 1000;
const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;

const DEVICE_ID_PATTERN = /^[a-f0-9]{16}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const SIGNATURE_PLACEHOLDER = Buffer.alloc(64).toString('base64url');
const DECISIONS = new Set([
  'accepted',
  'rejected',
  'busy',
  'unauthorized',
  'invalid-manifest',
  'expired',
  'unsupported'
]);
const COMPLETION_DIAGNOSTICS = new Set([
  'success',
  'hash-mismatch',
  'size-mismatch',
  'sequence-mismatch',
  'cancelled',
  'io-error',
  'protocol-error'
]);
const TRANSFER_TYPES = new Set([
  TYPE_TRANSFER_MANIFEST,
  TYPE_TRANSFER_DECISION,
  TYPE_TRANSFER_COMPLETE
]);
const utf8Decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function encodeTransferMessage(type, message, options = {}) {
  assertTransferType(type);
  const normalized = validateTransferMessage(type, message, options);
  const encoded = Buffer.from(canonicalJson(normalized), 'utf8');
  if (encoded.length === 0 || encoded.length > MAX_TRANSFER_MESSAGE_BYTES) {
    throw new RangeError('Transfer message payload exceeds the accepted bounds');
  }
  return encoded;
}

function decodeTransferMessage(type, payload, options = {}) {
  assertTransferType(type);
  if (!Buffer.isBuffer(payload) && !(payload instanceof Uint8Array)) {
    throw new TypeError('Transfer message payload must be bytes');
  }
  const bytes = Buffer.from(payload);
  if (bytes.length === 0 || bytes.length > MAX_TRANSFER_MESSAGE_BYTES) {
    throw new RangeError('Transfer message payload exceeds the accepted bounds');
  }
  const text = utf8Decoder.decode(bytes);
  const parsed = parseCanonicalJson(text, 'Transfer message payload');
  const normalized = validateTransferMessage(type, parsed, options);
  if (canonicalJson(normalized) !== text) {
    throw new SyntaxError('Transfer message payload is not in normalized canonical form');
  }
  return normalized;
}

function transferMessageSigningPayload(type, message) {
  assertTransferType(type);
  assertPlainObject(message, 'Transfer message');

  const candidate = { ...message };
  if (!Object.hasOwn(candidate, 'signature')) {
    candidate.signature = SIGNATURE_PLACEHOLDER;
  }

  // Signature bytes are deliberately excluded. Using issuedAt as the validation
  // clock keeps the payload stable after expiry while still enforcing TTL shape.
  const normalized = validateTransferMessage(type, candidate, { now: candidate.issuedAt });
  const unsigned = { ...normalized };
  delete unsigned.signature;
  return canonicalJson(unsigned);
}

function validateTransferMessage(type, message, options = {}) {
  assertTransferType(type);
  assertPlainObject(message, 'Transfer message');
  const now = normalizeNow(options.now);

  switch (type) {
    case TYPE_TRANSFER_MANIFEST:
      return validateManifestEnvelope(message, now);
    case TYPE_TRANSFER_DECISION:
      return validateDecision(message, now);
    case TYPE_TRANSFER_COMPLETE:
      return validateComplete(message, now);
    default:
      throw new TypeError('Unsupported transfer message type');
  }
}

function validateManifestEnvelope(message, now) {
  assertExactKeys(message, [
    'app',
    'protocolVersion',
    'type',
    'manifest',
    'senderDeviceId',
    'receiverDeviceId',
    'senderEphemeralPublicKey',
    'issuedAt',
    'expiresAt',
    'signature'
  ], 'Transfer manifest envelope');
  assertProtocolEnvelope(message, TYPE_TRANSFER_MANIFEST, 'Transfer manifest envelope');
  const manifest = normalizeTransferManifest(message.manifest);
  assertRoute(message.senderDeviceId, message.receiverDeviceId);
  assertCanonicalBase64Url(message.senderEphemeralPublicKey, 32, 'Sender ephemeral public key');
  assertTimeWindow(message.issuedAt, message.expiresAt, now);
  assertCanonicalBase64Url(message.signature, 64, 'Transfer message signature');

  return {
    app: APP_ID,
    protocolVersion: PROTOCOL_VERSION,
    type: TYPE_TRANSFER_MANIFEST,
    manifest,
    senderDeviceId: message.senderDeviceId,
    receiverDeviceId: message.receiverDeviceId,
    senderEphemeralPublicKey: message.senderEphemeralPublicKey,
    issuedAt: message.issuedAt,
    expiresAt: message.expiresAt,
    signature: message.signature
  };
}

function validateDecision(message, now) {
  assertExactKeys(message, [
    'app',
    'protocolVersion',
    'type',
    'taskId',
    'senderDeviceId',
    'receiverDeviceId',
    'decision',
    'issuedAt',
    'expiresAt',
    'signature'
  ], 'Transfer decision');
  assertProtocolEnvelope(message, TYPE_TRANSFER_DECISION, 'Transfer decision');
  assertValidTaskId(message.taskId);
  assertRoute(message.senderDeviceId, message.receiverDeviceId);
  if (typeof message.decision !== 'string' || !DECISIONS.has(message.decision)) {
    throw new TypeError('Transfer decision diagnostic is unsupported');
  }
  assertTimeWindow(message.issuedAt, message.expiresAt, now);
  assertCanonicalBase64Url(message.signature, 64, 'Transfer message signature');

  return {
    app: APP_ID,
    protocolVersion: PROTOCOL_VERSION,
    type: TYPE_TRANSFER_DECISION,
    taskId: message.taskId,
    senderDeviceId: message.senderDeviceId,
    receiverDeviceId: message.receiverDeviceId,
    decision: message.decision,
    issuedAt: message.issuedAt,
    expiresAt: message.expiresAt,
    signature: message.signature
  };
}

function validateComplete(message, now) {
  assertExactKeys(message, [
    'app',
    'protocolVersion',
    'type',
    'taskId',
    'senderDeviceId',
    'receiverDeviceId',
    'status',
    'diagnostic',
    'sha256',
    'bytes',
    'sequence',
    'issuedAt',
    'expiresAt',
    'signature'
  ], 'Transfer completion');
  assertProtocolEnvelope(message, TYPE_TRANSFER_COMPLETE, 'Transfer completion');
  assertValidTaskId(message.taskId);
  assertRoute(message.senderDeviceId, message.receiverDeviceId);
  if (message.status !== 'success' && message.status !== 'failed') {
    throw new TypeError('Transfer completion status must be success or failed');
  }
  if (typeof message.diagnostic !== 'string' || !COMPLETION_DIAGNOSTICS.has(message.diagnostic)) {
    throw new TypeError('Transfer completion diagnostic is unsupported');
  }
  if (message.status === 'success') {
    if (message.diagnostic !== 'success') {
      throw new TypeError('Successful transfer completion must use the success diagnostic');
    }
    assertSha256(message.sha256);
  } else {
    if (message.diagnostic === 'success') {
      throw new TypeError('Failed transfer completion must use a failure diagnostic');
    }
    if (message.sha256 !== null) {
      throw new TypeError('Failed transfer completion must not claim a verified SHA-256');
    }
  }
  assertNonNegativeSafeInteger(message.bytes, 'Transfer completion byte count');
  assertNonNegativeSafeInteger(message.sequence, 'Transfer completion sequence');
  assertTimeWindow(message.issuedAt, message.expiresAt, now);
  assertCanonicalBase64Url(message.signature, 64, 'Transfer message signature');

  return {
    app: APP_ID,
    protocolVersion: PROTOCOL_VERSION,
    type: TYPE_TRANSFER_COMPLETE,
    taskId: message.taskId,
    senderDeviceId: message.senderDeviceId,
    receiverDeviceId: message.receiverDeviceId,
    status: message.status,
    diagnostic: message.diagnostic,
    sha256: message.sha256,
    bytes: message.bytes,
    sequence: message.sequence,
    issuedAt: message.issuedAt,
    expiresAt: message.expiresAt,
    signature: message.signature
  };
}

function assertProtocolEnvelope(message, expectedType, label) {
  if (message.app !== APP_ID || message.protocolVersion !== PROTOCOL_VERSION || message.type !== expectedType) {
    throw new TypeError(`${label} protocol envelope is invalid`);
  }
}

function assertRoute(senderDeviceId, receiverDeviceId) {
  assertDeviceId(senderDeviceId, 'Sender device ID');
  assertDeviceId(receiverDeviceId, 'Receiver device ID');
  if (senderDeviceId === receiverDeviceId) {
    throw new TypeError('Transfer message sender and receiver must differ');
  }
}

function assertDeviceId(value, label) {
  if (typeof value !== 'string' || !DEVICE_ID_PATTERN.test(value)) {
    throw new TypeError(`${label} must be 16 lowercase hexadecimal characters`);
  }
}

function assertSha256(value) {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    throw new TypeError('Transfer completion SHA-256 must be 64 lowercase hexadecimal characters');
  }
}

function assertCanonicalBase64Url(value, expectedBytes, label) {
  if (typeof value !== 'string' || !BASE64URL_PATTERN.test(value)) {
    throw new TypeError(`${label} must use unpadded base64url`);
  }
  let decoded;
  try {
    decoded = Buffer.from(value, 'base64url');
  } catch (_) {
    throw new TypeError(`${label} must be valid base64url`);
  }
  if (decoded.length !== expectedBytes || decoded.toString('base64url') !== value) {
    throw new TypeError(`${label} must be canonical base64url for ${expectedBytes} bytes`);
  }
}

function assertTimeWindow(issuedAt, expiresAt, now) {
  assertPositiveSafeInteger(issuedAt, 'Transfer message issuedAt');
  assertPositiveSafeInteger(expiresAt, 'Transfer message expiresAt');
  if (expiresAt <= issuedAt || expiresAt - issuedAt > MAX_MESSAGE_TTL_MS) {
    throw new RangeError('Transfer message expiration window is invalid');
  }
  if (issuedAt > now && issuedAt - now > MAX_CLOCK_SKEW_MS) {
    throw new RangeError('Transfer message issue time is too far in the future');
  }
  if (expiresAt < now) {
    throw new RangeError('Transfer message has expired');
  }
}

function normalizeNow(value) {
  const now = value === undefined ? Date.now() : value;
  assertPositiveSafeInteger(now, 'Transfer message validation time');
  return now;
}

function assertPositiveSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_SAFE_INTEGER) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
}

function assertNonNegativeSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_SAFE_INTEGER) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
}

function assertPlainObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new TypeError(`${label} must be a plain object`);
  }
}

function assertExactKeys(value, expected, label) {
  const expectedSet = new Set(expected);
  for (const key of expected) {
    if (!Object.hasOwn(value, key)) throw new TypeError(`${label} is missing ${key}`);
  }
  for (const key of Object.keys(value)) {
    if (!expectedSet.has(key)) throw new TypeError(`${label} contains unknown field ${key}`);
  }
}

function assertTransferType(type) {
  if (typeof type !== 'string' || !TRANSFER_TYPES.has(type)) {
    throw new TypeError('Unsupported transfer message type');
  }
}

module.exports = {
  COMPLETION_DIAGNOSTICS,
  DECISIONS,
  MAX_CLOCK_SKEW_MS,
  MAX_MESSAGE_TTL_MS,
  MAX_TRANSFER_MESSAGE_BYTES,
  TYPE_TRANSFER_COMPLETE,
  TYPE_TRANSFER_DECISION,
  TYPE_TRANSFER_MANIFEST,
  decodeTransferMessage,
  encodeTransferMessage,
  transferMessageSigningPayload,
  validateTransferMessage
};

'use strict';

const { TextDecoder } = require('util');
const { MESSAGE_TYPES } = require('./constants');
const { canonicalJson, parseCanonicalJson } = require('./canonical-json');
const {
  assertValidPairingOffer,
  assertValidPairingConfirmation,
  assertValidPairingCancel
} = require('./pairing');

const MAX_CONTROL_PAYLOAD_BYTES = 12 * 1024;
const CONTROL_TYPES = new Set([
  MESSAGE_TYPES.PAIRING_OFFER,
  MESSAGE_TYPES.PAIRING_CONFIRM,
  MESSAGE_TYPES.PAIRING_CANCEL
]);
const utf8Decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function encodeControlMessage(type, message) {
  assertControlType(type);
  const normalized = validateControlMessage(type, message);
  const encoded = Buffer.from(canonicalJson(normalized), 'utf8');
  if (encoded.length > MAX_CONTROL_PAYLOAD_BYTES) throw new RangeError('Control payload exceeds the accepted limit');
  return encoded;
}

function decodeControlMessage(type, payload) {
  assertControlType(type);
  if (!Buffer.isBuffer(payload) && !(payload instanceof Uint8Array)) throw new TypeError('Control payload must be bytes');
  const bytes = Buffer.from(payload);
  if (bytes.length === 0 || bytes.length > MAX_CONTROL_PAYLOAD_BYTES) throw new RangeError('Control payload exceeds the accepted bounds');
  const text = utf8Decoder.decode(bytes);
  const parsed = parseCanonicalJson(text, 'Control payload');
  return validateControlMessage(type, parsed);
}

function validateControlMessage(type, message) {
  assertPlainObject(message, 'Control message');
  switch (type) {
    case MESSAGE_TYPES.PAIRING_OFFER:
      assertExactKeys(message, ['offer', 'signature'], 'Pairing offer message');
      assertValidPairingOffer(message.offer);
      assertSignature(message.signature);
      return { offer: message.offer, signature: message.signature };
    case MESSAGE_TYPES.PAIRING_CONFIRM:
      assertExactKeys(message, ['confirmation', 'signature'], 'Pairing confirmation message');
      assertValidPairingConfirmation(message.confirmation);
      assertSignature(message.signature);
      return { confirmation: message.confirmation, signature: message.signature };
    case MESSAGE_TYPES.PAIRING_CANCEL:
      assertExactKeys(message, ['cancellation', 'signature'], 'Pairing cancellation message');
      assertValidPairingCancel(message.cancellation);
      assertSignature(message.signature);
      return { cancellation: message.cancellation, signature: message.signature };
    default:
      throw new TypeError('Unsupported control message type');
  }
}

function assertControlType(type) {
  if (typeof type !== 'string' || !CONTROL_TYPES.has(type)) throw new TypeError('Unsupported control message type');
}

function assertSignature(signature) {
  if (typeof signature !== 'string' || signature.length === 0 || signature.length > 512) {
    throw new TypeError('Control message signature is invalid');
  }
}

function assertPlainObject(value, name) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new TypeError(`${name} must be a plain object`);
  }
}

function assertExactKeys(value, required, name) {
  const allowed = new Set(required);
  for (const key of required) if (!Object.hasOwn(value, key)) throw new TypeError(`${name} is missing ${key}`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`${name} contains unknown field ${key}`);
}

module.exports = {
  MAX_CONTROL_PAYLOAD_BYTES,
  encodeControlMessage,
  decodeControlMessage,
  validateControlMessage
};
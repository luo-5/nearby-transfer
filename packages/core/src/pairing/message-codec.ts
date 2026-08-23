/**
 * Pairing control message encode/decode (offer/confirm/cancel payloads).
 * Ported from src/v2/message-codec.js (the pairing message codec, NOT the
 * transfer message codec which lives in transfer/message-codec.ts).
 */

import { Buffer } from 'node:buffer';
import { TextDecoder } from 'node:util';
import { MESSAGE_TYPES } from '../constants.js';
import { canonicalJson, parseCanonicalJson, type CanonicalValue } from '../canonical-json.js';
import { assertValidPairingOffer, assertValidPairingConfirmation, assertValidPairingCancel } from './sas.js';

export const MAX_CONTROL_PAYLOAD_BYTES = 12 * 1024;
const CONTROL_TYPES: Set<string> = new Set([MESSAGE_TYPES.PAIRING_OFFER, MESSAGE_TYPES.PAIRING_CONFIRM, MESSAGE_TYPES.PAIRING_CANCEL]);
const utf8Decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export function encodeControlMessage(type: string, message: Record<string, unknown>): Buffer {
  assertControlType(type);
  const normalized = validateControlMessage(type, message);
  const encoded = Buffer.from(canonicalJson(normalized as unknown as CanonicalValue), 'utf8');
  if (encoded.length > MAX_CONTROL_PAYLOAD_BYTES) throw new RangeError('Control payload exceeds the accepted limit');
  return encoded;
}

export function decodeControlMessage(type: string, payload: Uint8Array): Record<string, unknown> {
  assertControlType(type);
  if (!Buffer.isBuffer(payload) && !(payload instanceof Uint8Array)) throw new TypeError('Control payload must be bytes');
  const bytes = Buffer.from(payload);
  if (bytes.length === 0 || bytes.length > MAX_CONTROL_PAYLOAD_BYTES) throw new RangeError('Control payload exceeds the accepted bounds');
  const text = utf8Decoder.decode(bytes);
  const parsed = parseCanonicalJson(text, 'Control payload');
  return validateControlMessage(type, parsed as Record<string, unknown>);
}

export function validateControlMessage(type: string, message: Record<string, unknown>): Record<string, unknown> {
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

function assertControlType(type: string): void {
  if (typeof type !== 'string' || !CONTROL_TYPES.has(type)) throw new TypeError('Unsupported control message type');
}

function assertSignature(signature: unknown): void {
  if (typeof signature !== 'string' || signature.length === 0 || signature.length > 512) {
    throw new TypeError('Control message signature is invalid');
  }
}

function assertPlainObject(value: unknown, name: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new TypeError(`${name} must be a plain object`);
  }
}

function assertExactKeys(value: Record<string, unknown>, required: string[], name: string): void {
  const allowed = new Set(required);
  for (const key of required) if (!Object.hasOwn(value, key)) throw new TypeError(`${name} is missing ${key}`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`${name} contains unknown field ${key}`);
}

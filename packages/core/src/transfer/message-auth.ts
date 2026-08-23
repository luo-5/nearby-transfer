/**
 * Ed25519 signing and verification for transfer control messages.
 * Ported from src/v2/transfer-message-auth.js.
 *
 * Signs the canonical-JSON signing payload (excluding the signature field)
 * with the sender's Ed25519 private key, and verifies against the sender's
 * public key. The signature is base64url-encoded and carried in the message's
 * `signature` field.
 */

import crypto from 'node:crypto';
import { Buffer } from 'node:buffer';
import { MAX_PUBLIC_KEY_LENGTH } from '../constants.js';
import {
  TYPE_TRANSFER_COMPLETE,
  TYPE_TRANSFER_DECISION,
  TYPE_TRANSFER_MANIFEST,
  TYPE_TRANSFER_PROGRESS,
  TYPE_TRANSFER_RESUME,
  encodeTransferMessage,
  transferMessageSigningPayload,
  validateTransferMessage,
} from './message-codec.js';

const SIGNATURE_BYTES = 64;
const SIGNATURE_PLACEHOLDER = Buffer.alloc(SIGNATURE_BYTES).toString('base64url');
const TRANSFER_TYPES: Set<string> = new Set([
  TYPE_TRANSFER_MANIFEST,
  TYPE_TRANSFER_DECISION,
  TYPE_TRANSFER_COMPLETE,
  TYPE_TRANSFER_RESUME,
  TYPE_TRANSFER_PROGRESS,
]);

export function signTransferMessage(
  type: string,
  unsignedMessage: Record<string, unknown>,
  signingPrivateKeyPem: string,
  options: Record<string, unknown> = {},
): Record<string, unknown> {
  assertInvocation(type, options);
  assertUnsignedMessage(unsignedMessage);

  const normalizedPlaceholder = validateTransferMessage(type, { ...unsignedMessage, signature: SIGNATURE_PLACEHOLDER }, options);
  encodeTransferMessage(type, normalizedPlaceholder, options);

  const normalizedUnsigned = { ...normalizedPlaceholder };
  delete (normalizedUnsigned as Record<string, unknown>).signature;
  const signingPayload = transferMessageSigningPayload(type, normalizedUnsigned);
  const signingKey = readEd25519PrivateKey(signingPrivateKeyPem);
  const signatureBytes = crypto.sign(null, Buffer.from(signingPayload, 'utf8'), signingKey);
  if (signatureBytes.length !== SIGNATURE_BYTES) {
    throw new Error('Ed25519 produced an unexpected signature length');
  }

  const normalized = validateTransferMessage(type, { ...normalizedUnsigned, signature: signatureBytes.toString('base64url') }, options);
  encodeTransferMessage(type, normalized, options);
  return normalized;
}

export function verifyTransferMessage(
  type: string,
  signedMessage: Record<string, unknown>,
  signingPublicKeyPem: string,
  options: Record<string, unknown> = {},
): boolean {
  assertInvocation(type, options);

  try {
    const normalized = validateTransferMessage(type, signedMessage, options);
    encodeTransferMessage(type, normalized, options);
    const signingKey = readEd25519PublicKey(signingPublicKeyPem);
    if (signingKey === null) return false;

    const signature = Buffer.from((normalized as Record<string, unknown>).signature as string, 'base64url');
    return crypto.verify(
      null,
      Buffer.from(transferMessageSigningPayload(type, normalized), 'utf8'),
      signingKey,
      signature,
    );
  } catch {
    return false;
  }
}

function assertInvocation(type: string, options: Record<string, unknown>): void {
  if (typeof type !== 'string' || !TRANSFER_TYPES.has(type)) {
    throw new TypeError('Unsupported transfer message type');
  }
  if (!isPlainObject(options)) {
    throw new TypeError('Transfer message authentication options must be a plain object');
  }
  if (Object.hasOwn(options, 'previous')) {
    throw new TypeError('Transfer control validation requires a complete checkpoint, not options.previous');
  }
  if (Object.hasOwn(options, 'now') && (!Number.isSafeInteger(options.now) || (options.now as number) <= 0)) {
    throw new TypeError('Transfer message validation time must be a positive safe integer');
  }
}

function assertUnsignedMessage(message: Record<string, unknown>): void {
  if (!isPlainObject(message)) {
    throw new TypeError('Unsigned transfer message must be a plain object');
  }
  if (Object.hasOwn(message, 'signature')) {
    throw new TypeError('Unsigned transfer message must not contain a signature');
  }
}

function readEd25519PrivateKey(pem: string): crypto.KeyObject {
  assertBoundedPem(pem, 'PRIVATE KEY', 'Transfer signing private key');
  let key: crypto.KeyObject;
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

function readEd25519PublicKey(pem: string): crypto.KeyObject | null {
  try {
    assertBoundedPem(pem, 'PUBLIC KEY', 'Transfer signing public key');
    const key = crypto.createPublicKey(pem);
    return key.asymmetricKeyType === 'ed25519' ? key : null;
  } catch {
    return null;
  }
}

function assertBoundedPem(pem: string, label: string, subject: string): void {
  if (typeof pem !== 'string' || pem.length === 0 || pem.length > MAX_PUBLIC_KEY_LENGTH || pem.includes('\0')) {
    throw new TypeError(`${subject} must be bounded PEM text`);
  }
  const normalized = pem.replace(/\r\n/g, '\n');
  if (
    normalized.includes('\r') ||
    !normalized.startsWith(`-----BEGIN ${label}-----\n`) ||
    (!normalized.endsWith(`\n-----END ${label}-----`) && !normalized.endsWith(`\n-----END ${label}-----\n`))
  ) {
    throw new TypeError(`${subject} must use ${label} PEM framing`);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

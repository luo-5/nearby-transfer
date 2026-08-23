/**
 * Session key agreement (X25519 ECDH + HKDF-SHA256) and AES-256-GCM chunk
 * encryption/decryption for the v2 transfer protocol.
 *
 * Ported from src/v2/transfer-session-crypto.js. The encryption is
 * authenticated with additional authenticated data (AAD) binding each chunk to
 * its task id, path, offset, sequence, and plaintext length, so a chunk cannot
 * be replayed at the wrong position. The encryptor generates the nonce; callers
 * never supply one, eliminating cross-chunk IV reuse.
 */

import crypto from 'node:crypto';
import { Buffer } from 'node:buffer';
import { assertValidRelativePath, assertValidTaskId, assertWellFormedString } from '../transfer/manifest-validation.js';

export const CONTEXT = 'nearby-transfer/v2/file-content';
export const SESSION_LABEL = 'session-key';
export const CHUNK_AAD_LABEL = 'chunk-aad';
export const KEY_BYTES = 32;
export const NONCE_BYTES = 12;
export const AUTH_TAG_BYTES = 16;
export const MAX_CHUNK_BYTES = 1024 * 1024;
export const MAX_SEQUENCE = Number.MAX_SAFE_INTEGER;

const DEVICE_ID_PATTERN = /^[a-f0-9]{16}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const X25519_PRIVATE_DER_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex');
const X25519_PUBLIC_DER_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');

export interface SessionKeyInput {
  localPrivateKeyPem: string;
  remotePublicKeyPem: string;
  senderDeviceId: string;
  receiverDeviceId: string;
  taskId: string;
  manifestSha256: string;
}

export interface ChunkEncryptInput {
  key: Uint8Array;
  taskId: string;
  path: string;
  offset: number;
  sequence: number;
  plaintext: Uint8Array;
}

export interface ChunkDecryptInput {
  key: Uint8Array;
  nonce: Uint8Array;
  taskId: string;
  path: string;
  offset: number;
  sequence: number;
  plainLength: number;
  ciphertext: Uint8Array;
  authTag: Uint8Array;
}

export interface EncryptedChunk {
  nonce: Buffer;
  ciphertext: Buffer;
  authTag: Buffer;
}

export interface ChunkMetadata {
  taskId: string;
  path: string;
  offset: number;
  sequence: number;
  plainLength: number;
}

interface SessionBinding {
  senderDeviceId: string;
  receiverDeviceId: string;
  taskId: string;
  manifestSha256: string;
}

/** Derive a 32-byte session key from an X25519 ECDH exchange, bound to the transfer context. */
export function deriveSessionKey(input: SessionKeyInput): Buffer {
  assertPlainObject(input, 'Session key input');
  assertExactKeys(input, ['localPrivateKeyPem', 'remotePublicKeyPem', 'senderDeviceId', 'receiverDeviceId', 'taskId', 'manifestSha256'], 'Session key input');

  const binding = normalizeSessionBinding(input);
  const privateKey = readX25519PrivateKey(input.localPrivateKeyPem);
  const publicKey = readX25519PublicKey(input.remotePublicKeyPem);
  let sharedSecret: Buffer;
  try {
    sharedSecret = crypto.diffieHellman({ privateKey, publicKey });
  } catch (error) {
    throw new TypeError('Unable to derive an X25519 shared secret', { cause: error });
  }
  if (sharedSecret.length !== KEY_BYTES || isAllZero(sharedSecret)) {
    sharedSecret.fill(0);
    throw new Error('X25519 produced an invalid shared secret');
  }

  const salt = Buffer.from(binding.manifestSha256, 'hex');
  const info = encodeFields([CONTEXT, SESSION_LABEL, binding.senderDeviceId, binding.receiverDeviceId, binding.taskId, binding.manifestSha256]);
  try {
    return Buffer.from(crypto.hkdfSync('sha256', sharedSecret, salt, info, KEY_BYTES));
  } finally {
    sharedSecret.fill(0);
  }
}

/** Build the additional authenticated data (AAD) for a chunk. Exposed for testing. */
export function buildChunkAad(input: ChunkMetadata): Buffer {
  assertPlainObject(input, 'Chunk AAD input');
  assertExactKeys(input, ['taskId', 'path', 'offset', 'sequence', 'plainLength'], 'Chunk AAD input');
  const metadata = normalizeChunkMetadata(input);
  return Buffer.concat([
    encodeFields([CONTEXT, CHUNK_AAD_LABEL, metadata.taskId, metadata.path]),
    encodeSafeInteger(metadata.offset),
    encodeSafeInteger(metadata.sequence),
    encodeUint32(metadata.plainLength),
  ]);
}

/** Encrypt a plaintext chunk. The nonce is generated internally and returned. */
export function encryptChunk(input: ChunkEncryptInput): EncryptedChunk {
  assertPlainObject(input, 'Chunk encryption input');
  assertExactKeys(input, ['key', 'taskId', 'path', 'offset', 'sequence', 'plaintext'], 'Chunk encryption input');
  const key = requireBytes(input.key, KEY_BYTES, 'Session key');
  const plaintext = requireBoundedBytes(input.plaintext, 'Chunk plaintext');
  const aad = buildChunkAad({
    taskId: input.taskId,
    path: input.path,
    offset: input.offset,
    sequence: input.sequence,
    plainLength: plaintext.length,
  });
  const nonce = crypto.randomBytes(NONCE_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce, { authTagLength: AUTH_TAG_BYTES });
  cipher.setAAD(aad, { plaintextLength: plaintext.length });
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { nonce, ciphertext, authTag: cipher.getAuthTag() };
}

/** Decrypt and authenticate a chunk. Throws if the authentication tag does not verify. */
export function decryptChunk(input: ChunkDecryptInput): Buffer {
  assertPlainObject(input, 'Chunk decryption input');
  assertExactKeys(input, ['key', 'nonce', 'taskId', 'path', 'offset', 'sequence', 'plainLength', 'ciphertext', 'authTag'], 'Chunk decryption input');
  const key = requireBytes(input.key, KEY_BYTES, 'Session key');
  const nonce = requireBytes(input.nonce, NONCE_BYTES, 'Chunk nonce');
  const ciphertext = requireBoundedBytes(input.ciphertext, 'Chunk ciphertext');
  const authTag = requireBytes(input.authTag, AUTH_TAG_BYTES, 'Chunk authentication tag');
  const metadata = normalizeChunkMetadata(input);
  if (ciphertext.length !== metadata.plainLength) {
    throw new RangeError('Chunk ciphertext length must equal the authenticated plaintext length');
  }
  const aad = buildChunkAad(metadata);

  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: AUTH_TAG_BYTES });
    decipher.setAAD(aad, { plaintextLength: metadata.plainLength });
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    if (plaintext.length !== metadata.plainLength) {
      plaintext.fill(0);
      throw new Error('Authenticated plaintext length mismatch');
    }
    return plaintext;
  } catch (error) {
    throw new Error('Chunk authentication failed', { cause: error });
  }
}

function normalizeSessionBinding(input: SessionKeyInput): SessionBinding {
  assertDeviceId(input.senderDeviceId, 'Sender device ID');
  assertDeviceId(input.receiverDeviceId, 'Receiver device ID');
  if (input.senderDeviceId === input.receiverDeviceId) {
    throw new TypeError('Sender and receiver device IDs must be different');
  }
  assertValidTaskId(input.taskId);
  if (typeof input.manifestSha256 !== 'string' || !SHA256_PATTERN.test(input.manifestSha256)) {
    throw new TypeError('Manifest SHA-256 must be 64 lowercase hexadecimal characters');
  }
  return {
    senderDeviceId: input.senderDeviceId,
    receiverDeviceId: input.receiverDeviceId,
    taskId: input.taskId,
    manifestSha256: input.manifestSha256,
  };
}

function normalizeChunkMetadata(input: ChunkMetadata): ChunkMetadata {
  assertValidTaskId(input.taskId);
  assertValidRelativePath(input.path);
  assertSafeInteger(input.offset, 0, Number.MAX_SAFE_INTEGER, 'Chunk offset');
  assertSafeInteger(input.sequence, 0, MAX_SEQUENCE, 'Chunk sequence');
  assertSafeInteger(input.plainLength, 0, MAX_CHUNK_BYTES, 'Chunk plaintext length');
  if (input.offset > Number.MAX_SAFE_INTEGER - input.plainLength) {
    throw new RangeError('Chunk byte range exceeds the maximum safe integer');
  }
  return { taskId: input.taskId, path: input.path, offset: input.offset, sequence: input.sequence, plainLength: input.plainLength };
}

function readX25519PrivateKey(pem: string): crypto.KeyObject {
  const der = readCanonicalPem(pem, 'PRIVATE KEY', X25519_PRIVATE_DER_PREFIX, KEY_BYTES, 'Local X25519 private key');
  try {
    const key = crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
    if (key.asymmetricKeyType !== 'x25519' || !key.export({ format: 'der', type: 'pkcs8' }).equals(der)) {
      throw new TypeError('Local private key must be canonical X25519 PKCS#8');
    }
    return key;
  } catch (error) {
    if (error instanceof TypeError && error.message === 'Local private key must be canonical X25519 PKCS#8') {
      throw error;
    }
    throw new TypeError('Local X25519 private key is unreadable', { cause: error });
  }
}

function readX25519PublicKey(pem: string): crypto.KeyObject {
  const der = readCanonicalPem(pem, 'PUBLIC KEY', X25519_PUBLIC_DER_PREFIX, KEY_BYTES, 'Remote X25519 public key');
  try {
    const key = crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
    if (key.asymmetricKeyType !== 'x25519' || !key.export({ format: 'der', type: 'spki' }).equals(der)) {
      throw new TypeError('Remote public key must be canonical X25519 SPKI');
    }
    return key;
  } catch (error) {
    if (error instanceof TypeError && error.message === 'Remote public key must be canonical X25519 SPKI') {
      throw error;
    }
    throw new TypeError('Remote X25519 public key is unreadable', { cause: error });
  }
}

function readCanonicalPem(pem: string, label: string, prefix: Buffer, rawKeyBytes: number, subject: string): Buffer {
  if (typeof pem !== 'string' || pem.length === 0 || pem.length > 4096 || pem.includes('\0')) {
    throw new TypeError(`${subject} must be bounded PEM text`);
  }
  const normalized = pem.replace(/\r\n/g, '\n');
  if (normalized.includes('\r')) {
    throw new TypeError(`${subject} must use valid PEM line endings`);
  }
  const header = `-----BEGIN ${label}-----\n`;
  const footer = `\n-----END ${label}-----`;
  if (!normalized.startsWith(header) || (!normalized.endsWith(footer) && !normalized.endsWith(`${footer}\n`))) {
    throw new TypeError(`${subject} must use ${label} PEM framing`);
  }
  const bodyEnd = normalized.endsWith('\n') ? normalized.length - footer.length - 1 : normalized.length - footer.length;
  const body = normalized.slice(header.length, bodyEnd);
  const lines = body.split('\n');
  if (lines.some((line) => line.length === 0 || line.length > 64 || !/^[A-Za-z0-9+/=]+$/.test(line))) {
    throw new TypeError(`${subject} contains invalid PEM base64`);
  }
  const base64 = lines.join('');
  if (!BASE64_PATTERN.test(base64)) {
    throw new TypeError(`${subject} contains non-canonical PEM base64`);
  }
  const der = Buffer.from(base64, 'base64');
  if (der.toString('base64') !== base64 || der.length !== prefix.length + rawKeyBytes || !der.subarray(0, prefix.length).equals(prefix)) {
    throw new TypeError(`${subject} must contain canonical X25519 key encoding`);
  }
  return der;
}

function encodeFields(fields: string[]): Buffer {
  return Buffer.concat(
    fields.map((field) => {
      if (typeof field !== 'string') {
        throw new TypeError('Protocol field must be a string');
      }
      assertWellFormedString(field, 'Protocol field');
      const encoded = Buffer.from(field, 'utf8');
      return Buffer.concat([encodeUint32(encoded.length), encoded]);
    }),
  );
}

function encodeSafeInteger(value: number): Buffer {
  const encoded = Buffer.alloc(8);
  encoded.writeBigUInt64BE(BigInt(value));
  return encoded;
}

function encodeUint32(value: number): Buffer {
  const encoded = Buffer.alloc(4);
  encoded.writeUInt32BE(value, 0);
  return encoded;
}

function requireBoundedBytes(value: Uint8Array, subject: string): Buffer {
  const bytes = requireByteArray(value, subject);
  if (bytes.length > MAX_CHUNK_BYTES) {
    throw new RangeError(`${subject} exceeds the maximum chunk size`);
  }
  return bytes;
}

function requireBytes(value: Uint8Array, length: number, subject: string): Buffer {
  const bytes = requireByteArray(value, subject);
  if (bytes.length !== length) {
    throw new RangeError(`${subject} must be exactly ${length} bytes`);
  }
  return bytes;
}

function requireByteArray(value: Uint8Array, subject: string): Buffer {
  if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) {
    throw new TypeError(`${subject} must be a Buffer or Uint8Array`);
  }
  return Buffer.from(value);
}

function assertDeviceId(value: string, subject: string): void {
  if (typeof value !== 'string' || !DEVICE_ID_PATTERN.test(value)) {
    throw new TypeError(`${subject} must be 16 lowercase hexadecimal characters`);
  }
}

function assertSafeInteger(value: number, minimum: number, maximum: number, subject: string): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${subject} must be a safe integer between ${minimum} and ${maximum}`);
  }
}

function assertPlainObject(value: unknown, subject: string): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${subject} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${subject} must be a plain object`);
  }
}

function assertExactKeys(value: object, expectedKeys: string[], subject: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${subject} contains missing or unknown fields`);
  }
}

function isAllZero(value: Uint8Array): boolean {
  let combined = 0;
  for (const current of value) {
    combined |= current;
  }
  return combined === 0;
}

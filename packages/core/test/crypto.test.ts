/**
 * Crypto layer tests for @luo-5/core.
 *
 * Validates that the migrated identity, session-key, and chunk-encryption code
 * produces output matching the deterministic vectors in
 * test/vectors/crypto-vectors.json, plus round-trip and tamper-detection tests.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import crypto from 'node:crypto';
import { Buffer } from 'node:buffer';

import {
  createEd25519KeyPair,
  createX25519KeyPair,
  createKeyPair,
  deriveDeviceId,
  fingerprintFor,
  sign,
  verify,
  deriveSessionKey,
  encryptChunk,
  decryptChunk,
  buildChunkAad,
} from '../src/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const vectors = JSON.parse(readFileSync(join(__dirname, 'vectors', 'crypto-vectors.json'), 'utf8'));

test('identity: deriveDeviceId and fingerprint match vector', () => {
  const { signingPublicKeyPem, deviceId, fingerprint } = vectors.identity;
  assert.equal(deriveDeviceId(signingPublicKeyPem), deviceId);
  assert.equal(fingerprintFor(signingPublicKeyPem), fingerprint);
  // deviceId is 16 hex chars
  assert.match(deviceId, /^[a-f0-9]{16}$/);
  // fingerprint is 6 groups of 4 hex chars
  assert.match(fingerprint, /^[0-9A-F]{4}(?:-[0-9A-F]{4}){5}$/);
});

test('identity: createEd25519KeyPair produces working sign/verify', () => {
  const pair = createEd25519KeyPair();
  const message = Buffer.from('hello identity');
  const signature = sign(message, pair.privateKey);
  assert.equal(verify(message, signature, pair.publicKey), true);
  assert.equal(verify(Buffer.from('tampered'), signature, pair.publicKey), false);
});

test('identity: createKeyPair dispatches by algorithm', () => {
  const ed = createKeyPair('ed25519');
  const x = createKeyPair('x25519');
  assert.match(ed.publicKey, /BEGIN PUBLIC KEY/);
  assert.match(x.publicKey, /BEGIN PUBLIC KEY/);
  // X25519 public key DER is 44 bytes -> base64 is 60 chars (no padding lines)
  assert.ok(x.publicKey.length > 0);
});

test('session: deriveSessionKey matches vector (Alice→Bob)', () => {
  const v = vectors.sessionKey;
  const key = deriveSessionKey({
    localPrivateKeyPem: v.alicePrivateKeyPem,
    remotePublicKeyPem: v.bobPublicKeyPem,
    senderDeviceId: v.senderDeviceId,
    receiverDeviceId: v.receiverDeviceId,
    taskId: v.taskId,
    manifestSha256: v.manifestSha256,
  });
  assert.equal(key.toString('hex'), v.sessionKeyHex);
});

test('session: deriveSessionKey is symmetric (Bob→Alice gives same key)', () => {
  const v = vectors.sessionKey;
  const keyBob = deriveSessionKey({
    localPrivateKeyPem: v.bobPrivateKeyPem,
    remotePublicKeyPem: v.alicePublicKeyPem,
    senderDeviceId: v.senderDeviceId,
    receiverDeviceId: v.receiverDeviceId,
    taskId: v.taskId,
    manifestSha256: v.manifestSha256,
  });
  assert.equal(keyBob.toString('hex'), v.sessionKeyHex);
});

test('session: different manifestSha256 produces a different key', () => {
  const v = vectors.sessionKey;
  const otherManifest = crypto.createHash('sha256').update('different-manifest').digest('hex');
  const key = deriveSessionKey({
    localPrivateKeyPem: v.alicePrivateKeyPem,
    remotePublicKeyPem: v.bobPublicKeyPem,
    senderDeviceId: v.senderDeviceId,
    receiverDeviceId: v.receiverDeviceId,
    taskId: v.taskId,
    manifestSha256: otherManifest,
  });
  assert.notEqual(key.toString('hex'), v.sessionKeyHex);
});

test('session: rejects same sender and receiver device id', () => {
  const v = vectors.sessionKey;
  assert.throws(
    () =>
      deriveSessionKey({
        localPrivateKeyPem: v.alicePrivateKeyPem,
        remotePublicKeyPem: v.bobPublicKeyPem,
        senderDeviceId: v.senderDeviceId,
        receiverDeviceId: v.senderDeviceId,
        taskId: v.taskId,
        manifestSha256: v.manifestSha256,
      }),
    /must be different/,
  );
});

test('chunk: encryptChunk then decryptChunk round-trips', () => {
  const key = Buffer.from(vectors.chunkEncryption.sessionKeyHex, 'hex');
  const plaintext = Buffer.from('round trip payload', 'utf8');
  const encrypted = encryptChunk({
    key,
    taskId: vectors.chunkEncryption.taskId,
    path: 'docs/readme.md',
    offset: 0,
    sequence: 0,
    plaintext,
  });
  const decrypted = decryptChunk({
    key,
    nonce: encrypted.nonce,
    taskId: vectors.chunkEncryption.taskId,
    path: 'docs/readme.md',
    offset: 0,
    sequence: 0,
    plainLength: plaintext.length,
    ciphertext: encrypted.ciphertext,
    authTag: encrypted.authTag,
  });
  assert.deepEqual(decrypted, plaintext);
});

test('chunk: decryptChunk matches vector output', () => {
  const v = vectors.chunkEncryption;
  const key = Buffer.from(v.sessionKeyHex, 'hex');
  const decrypted = decryptChunk({
    key,
    nonce: Buffer.from(v.nonceHex, 'hex'),
    taskId: v.taskId,
    path: v.path,
    offset: v.offset,
    sequence: v.sequence,
    plainLength: Buffer.from(v.plaintextHex, 'hex').length,
    ciphertext: Buffer.from(v.ciphertextHex, 'hex'),
    authTag: Buffer.from(v.authTagHex, 'hex'),
  });
  assert.equal(decrypted.toString('utf8'), v.plaintextUtf8);
});

test('chunk: tampered ciphertext fails authentication', () => {
  const key = Buffer.from(vectors.chunkEncryption.sessionKeyHex, 'hex');
  const plaintext = Buffer.from('tamper me', 'utf8');
  const encrypted = encryptChunk({
    key,
    taskId: vectors.chunkEncryption.taskId,
    path: 'docs/readme.md',
    offset: 0,
    sequence: 0,
    plaintext,
  });
  const tampered = Buffer.from(encrypted.ciphertext);
  tampered[0] ^= 0xff;
  assert.throws(
    () =>
      decryptChunk({
        key,
        nonce: encrypted.nonce,
        taskId: vectors.chunkEncryption.taskId,
        path: 'docs/readme.md',
        offset: 0,
        sequence: 0,
        plainLength: plaintext.length,
        ciphertext: tampered,
        authTag: encrypted.authTag,
      }),
    /authentication failed/,
  );
});

test('chunk: wrong path in AAD fails authentication', () => {
  const key = Buffer.from(vectors.chunkEncryption.sessionKeyHex, 'hex');
  const plaintext = Buffer.from('path-bound', 'utf8');
  const encrypted = encryptChunk({
    key,
    taskId: vectors.chunkEncryption.taskId,
    path: 'docs/readme.md',
    offset: 0,
    sequence: 0,
    plaintext,
  });
  assert.throws(
    () =>
      decryptChunk({
        key,
        nonce: encrypted.nonce,
        taskId: vectors.chunkEncryption.taskId,
        path: 'other/path.md', // wrong path
        offset: 0,
        sequence: 0,
        plainLength: plaintext.length,
        ciphertext: encrypted.ciphertext,
        authTag: encrypted.authTag,
      }),
    /authentication failed/,
  );
});

test('chunk: AAD is deterministic for fixed metadata', () => {
  const aad1 = buildChunkAad({
    taskId: vectors.chunkEncryption.taskId,
    path: 'docs/readme.md',
    offset: 0,
    sequence: 0,
    plainLength: 42,
  });
  const aad2 = buildChunkAad({
    taskId: vectors.chunkEncryption.taskId,
    path: 'docs/readme.md',
    offset: 0,
    sequence: 0,
    plainLength: 42,
  });
  assert.deepEqual(aad1, aad2);
  // Different offset -> different AAD
  const aad3 = buildChunkAad({
    taskId: vectors.chunkEncryption.taskId,
    path: 'docs/readme.md',
    offset: 1,
    sequence: 0,
    plainLength: 42,
  });
  assert.notDeepEqual(aad1, aad3);
});

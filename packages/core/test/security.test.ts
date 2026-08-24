import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Buffer } from 'node:buffer';

import {
  timingSafeEqualStrings,
  timingSafeEqualBuffers,
  assertValidRelativePath,
  encodeWireFrame,
  WireFrameDecoder,
  MAX_FRAME_SIZE,
  encodeFrame,
  encryptChunk,
  decryptChunk,
  deriveSessionKey,
  createEd25519KeyPair,
  createX25519KeyPair,
  deriveDeviceId,
  createTaskId,
  APP_ID,
  PROTOCOL_VERSION,
  MESSAGE_TYPES,
} from '../src/index.js';

// ─── Timing-safe comparison ───────────────────────────────

test('security: timingSafeEqualStrings returns true for equal strings', () => {
  assert.equal(timingSafeEqualStrings('abc123', 'abc123'), true);
  assert.equal(timingSafeEqualStrings('', ''), true);
  assert.equal(timingSafeEqualStrings('a'.repeat(1000), 'a'.repeat(1000)), true);
});

test('security: timingSafeEqualStrings returns false for different strings', () => {
  assert.equal(timingSafeEqualStrings('abc123', 'abc124'), false);
  assert.equal(timingSafeEqualStrings('abc', 'abcd'), false);
  assert.equal(timingSafeEqualStrings('abc', 'abd'), false);
  assert.equal(timingSafeEqualStrings('abc', ''), false);
  assert.equal(timingSafeEqualStrings('', 'abc'), false);
});

test('security: timingSafeEqualBuffers returns correct results', () => {
  const a = Buffer.from('hello');
  const b = Buffer.from('hello');
  const c = Buffer.from('world');
  assert.equal(timingSafeEqualBuffers(a, b), true);
  assert.equal(timingSafeEqualBuffers(a, c), false);
  assert.equal(timingSafeEqualBuffers(a, Buffer.from('hell')), false);
});

// ─── Path traversal prevention ───────────────────────────

test('security: assertValidRelativePath rejects traversal attempts', () => {
  assert.throws(() => assertValidRelativePath('../etc/passwd'), /traversal/);
  assert.throws(() => assertValidRelativePath('folder/../../secret.txt'), /traversal/);
  assert.throws(() => assertValidRelativePath('..'), /traversal/);
  assert.throws(() => assertValidRelativePath('folder/..'), /traversal/);
});

test('security: assertValidRelativePath rejects absolute paths', () => {
  assert.throws(() => assertValidRelativePath('/etc/passwd'), /relative POSIX/);
  assert.throws(() => assertValidRelativePath('C:/windows.txt'), /relative POSIX/);
  assert.throws(() => assertValidRelativePath('folder\\windows.txt'), /relative POSIX/);
});

test('security: assertValidRelativePath rejects empty and null bytes', () => {
  assert.throws(() => assertValidRelativePath(''), /non-empty/);
  assert.throws(() => assertValidRelativePath('bad\u0000name.txt'), /character/);
});

test('security: assertValidRelativePath accepts safe paths', () => {
  assert.doesNotThrow(() => assertValidRelativePath('file.txt'));
  assert.doesNotThrow(() => assertValidRelativePath('folder/file.txt'));
  assert.doesNotThrow(() => assertValidRelativePath('a/b/c/d.txt'));
  assert.doesNotThrow(() => assertValidRelativePath('中文文件.txt'));
});

// ─── DoS: large frame rejection ──────────────────────────

test('security: wire frame decoder rejects oversized frames', () => {
  const decoder = new WireFrameDecoder();
  // Frame length > MAX_FRAME_SIZE (16 MB)
  const oversized = Buffer.alloc(8);
  oversized.writeUInt32BE(MAX_FRAME_SIZE + 1, 0);
  assert.throws(() => decoder.push(oversized), /Wire frame/);
});

test('security: wire frame encoder rejects oversized frames', () => {
  const bigPayload = Buffer.alloc(MAX_FRAME_SIZE); // exactly at limit (will fail because header adds bytes)
  assert.throws(() => encodeWireFrame({
    header: { app: APP_ID, protocolVersion: PROTOCOL_VERSION, type: MESSAGE_TYPES.TRANSFER_MANIFEST },
    payload: bigPayload,
  }), /exceeds/);
});

test('security: chunk frame encoder rejects oversized payloads', () => {
  const taskId = createTaskId();
  const oversizedCiphertext = Buffer.alloc(2 * 1024 * 1024); // 2 MB > MAX_CHUNK_BYTES (1 MB)
  assert.throws(() => encodeFrame({
    taskId,
    relativePath: 'test.bin',
    offset: 0,
    sequence: 0,
    plainLength: oversizedCiphertext.length,
    nonce: Buffer.alloc(12),
    authTag: Buffer.alloc(16),
    ciphertext: oversizedCiphertext,
  }), /exceeds/);
});

// ─── Nonce uniqueness ─────────────────────────────────────

test('security: encryptChunk produces unique random nonces', () => {
  const senderKeys = createEd25519KeyPair();
  const senderEnc = createX25519KeyPair();
  const receiverEnc = createX25519KeyPair();
  const senderId = deriveDeviceId(senderKeys.publicKey);
  const taskId = createTaskId();

  const sessionKey = deriveSessionKey({
    localPrivateKeyPem: senderEnc.privateKey,
    remotePublicKeyPem: receiverEnc.publicKey,
    senderDeviceId: senderId,
    receiverDeviceId: 'a1b2c3d4e5f60718',
    taskId,
    manifestSha256: '0'.repeat(64),
  });

  const plaintext = Buffer.alloc(1024, 0x42);
  const baseInput = {
    key: sessionKey,
    taskId,
    path: 'test.bin',
    offset: 0,
    sequence: 0,
    plaintext,
  };

  const encrypted1 = encryptChunk(baseInput);
  const encrypted2 = encryptChunk(baseInput);

  // Nonces must be different (random, not deterministic)
  assert.ok(!encrypted1.nonce.equals(encrypted2.nonce), 'nonces must differ between chunks');

  // Nonces must be 12 bytes (96 bits for AES-GCM)
  assert.equal(encrypted1.nonce.length, 12, 'nonce must be 12 bytes');
  assert.equal(encrypted2.nonce.length, 12, 'nonce must be 12 bytes');

  // Ciphertext must be different (because nonce is different)
  assert.ok(!encrypted1.ciphertext.equals(encrypted2.ciphertext), 'ciphertext must differ');

  // But both must decrypt to the same plaintext
  const decrypted1 = decryptChunk({
    key: sessionKey,
    nonce: encrypted1.nonce,
    taskId,
    path: 'test.bin',
    offset: 0,
    sequence: 0,
    plainLength: plaintext.length,
    ciphertext: encrypted1.ciphertext,
    authTag: encrypted1.authTag,
  });
  const decrypted2 = decryptChunk({
    key: sessionKey,
    nonce: encrypted2.nonce,
    taskId,
    path: 'test.bin',
    offset: 0,
    sequence: 0,
    plainLength: plaintext.length,
    ciphertext: encrypted2.ciphertext,
    authTag: encrypted2.authTag,
  });
  assert.ok(decrypted1.equals(plaintext), 'decrypted chunk 1 matches plaintext');
  assert.ok(decrypted2.equals(plaintext), 'decrypted chunk 2 matches plaintext');

  sessionKey.fill(0);
});

test('security: 1000 encryptions produce 1000 unique nonces', () => {
  const senderEnc = createX25519KeyPair();
  const receiverEnc = createX25519KeyPair();
  const taskId = createTaskId();
  const sessionKey = deriveSessionKey({
    localPrivateKeyPem: senderEnc.privateKey,
    remotePublicKeyPem: receiverEnc.publicKey,
    senderDeviceId: 'a1b2c3d4e5f60718',
    receiverDeviceId: 'b1b2c3d4e5f60718',
    taskId,
    manifestSha256: '0'.repeat(64),
  });

  const plaintext = Buffer.alloc(64, 0xFF);
  const nonces = new Set<string>();
  for (let i = 0; i < 1000; i++) {
    const encrypted = encryptChunk({
      key: sessionKey,
      taskId,
      path: 'test.bin',
      offset: i * 64,
      sequence: i,
      plaintext,
    });
    nonces.add(encrypted.nonce.toString('hex'));
  }
  assert.equal(nonces.size, 1000, 'all 1000 nonces must be unique');
  sessionKey.fill(0);
});

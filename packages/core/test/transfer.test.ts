/**
 * Transfer layer tests for @nearby-transfer/core.
 * Validates manifest, wire-frame, chunk-frame, and message-codec modules.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import crypto from 'node:crypto';

import {
  createTaskId,
  createTransferManifest,
  normalizeTransferManifest,
  serializeTransferManifest,
  parsePersistedTransferManifest,
  assertValidTaskId,
  assertValidRelativePath,
  CONFLICT_STRATEGY_AUTO_RENAME,
  encodeWireFrame,
  decodeWireFrame,
  WireFrameDecoder,
  encodeFrame as encodeChunkFrame,
  decodeFrame as decodeChunkFrame,
  TransferChunkFrameParser,
  encodeTransferMessage,
  decodeTransferMessage,
  transferMessageSigningPayload,
  validateTransferMessage,
  TYPE_TRANSFER_MANIFEST,
  TYPE_TRANSFER_DECISION,
  TYPE_TRANSFER_COMPLETE,
  APP_ID,
  PROTOCOL_VERSION,
  MESSAGE_TYPES,
  encryptChunk,
  deriveSessionKey,
  createEd25519KeyPair,
  createX25519KeyPair,
  deriveDeviceId,
  fingerprintFor,
} from '../src/index.js';

test('manifest: createTransferManifest produces a valid normalized manifest', () => {
  const manifest = createTransferManifest({
    entries: [
      { kind: 'directory', path: 'docs' },
      { kind: 'file', path: 'docs/readme.md', size: 100, sha256: crypto.createHash('sha256').update('x').digest('hex') },
    ],
  });
  assert.equal(manifest.app, APP_ID);
  assert.equal(manifest.protocolVersion, PROTOCOL_VERSION);
  assert.equal(manifest.type, MESSAGE_TYPES.TRANSFER_MANIFEST);
  assert.equal(manifest.conflictStrategy, CONFLICT_STRATEGY_AUTO_RENAME);
  assert.equal(manifest.totalFiles, 1);
  assert.equal(manifest.totalBytes, 100);
  assert.match(manifest.taskId, /^[A-Za-z0-9_-]{22}$/);
});

test('manifest: serialize and parsePersisted round-trips', () => {
  const manifest = createTransferManifest({
    entries: [{ kind: 'file', path: 'test.txt', size: 0, sha256: crypto.createHash('sha256').digest('hex') }],
  });
  const serialized = serializeTransferManifest(manifest);
  const parsed = parsePersistedTransferManifest(serialized);
  assert.equal(parsed.taskId, manifest.taskId);
  assert.equal(parsed.totalFiles, manifest.totalFiles);
});

test('manifest: rejects duplicate paths', () => {
  assert.throws(
    () => createTransferManifest({
      entries: [
        { kind: 'file', path: 'a.txt', size: 0, sha256: crypto.createHash('sha256').digest('hex') },
        { kind: 'file', path: 'a.txt', size: 0, sha256: crypto.createHash('sha256').digest('hex') },
      ],
    }),
    /duplicate/,
  );
});

test('manifest: rejects path traversal', () => {
  assert.throws(() => assertValidRelativePath('../escape'), /traversal/);
  assert.throws(() => assertValidRelativePath('/absolute'), /relative POSIX/);
  assert.throws(() => assertValidRelativePath(''), /non-empty/);
  assert.doesNotThrow(() => assertValidRelativePath('docs/readme.md'));
});

test('manifest: assertValidTaskId accepts canonical base64url', () => {
  const id = createTaskId();
  assert.doesNotThrow(() => assertValidTaskId(id));
  assert.throws(() => assertValidTaskId('short'), /base64url/);
});

test('wire-frame: encode and decode round-trips', () => {
  const frame = encodeWireFrame({
    header: { app: APP_ID, protocolVersion: PROTOCOL_VERSION, type: MESSAGE_TYPES.PAIRING_OFFER },
    payload: Buffer.from('test payload'),
  });
  const decoded = decodeWireFrame(frame);
  assert.equal(decoded.header.type, MESSAGE_TYPES.PAIRING_OFFER);
  assert.equal(decoded.payload.toString(), 'test payload');
});

test('wire-frame: WireFrameDecoder handles split frames', () => {
  const frame = encodeWireFrame({
    header: { app: APP_ID, protocolVersion: PROTOCOL_VERSION, type: MESSAGE_TYPES.PAIRING_CANCEL },
    payload: Buffer.from('split me'),
  });
  const decoder = new WireFrameDecoder();
  const half = frame.subarray(0, Math.floor(frame.length / 2));
  const rest = frame.subarray(Math.floor(frame.length / 2));
  assert.equal(decoder.push(half).length, 0);
  const frames = decoder.push(rest);
  assert.equal(frames.length, 1);
  assert.equal(frames[0]!.payload.toString(), 'split me');
});

test('wire-frame: rejects non-canonical header', () => {
  assert.throws(
    () => encodeWireFrame({ header: { app: 'wrong', protocolVersion: 2, type: 'pairing-offer' } as never }),
    /app must be/,
  );
});

test('chunk-frame: encode and decode round-trips', () => {
  const signing = createEd25519KeyPair();
  const encryption = createX25519KeyPair();
  const senderDeviceId = deriveDeviceId(signing.publicKey);
  const receiverDeviceId = '0123456789abcdef';
  const taskId = createTaskId();
  const manifestSha = crypto.createHash('sha256').update('m').digest('hex');
  const sessionKey = deriveSessionKey({
    localPrivateKeyPem: encryption.privateKey, remotePublicKeyPem: encryption.publicKey,
    senderDeviceId, receiverDeviceId, taskId, manifestSha256: manifestSha,
  });
  const plaintext = Buffer.from('chunk data');
  const encrypted = encryptChunk({ key: sessionKey, taskId, path: 'docs/readme.md', offset: 0, sequence: 0, plaintext });

  const encoded = encodeChunkFrame({
    taskId, relativePath: 'docs/readme.md', offset: 0, sequence: 0, plainLength: plaintext.length,
    nonce: encrypted.nonce, authTag: encrypted.authTag, ciphertext: encrypted.ciphertext,
  });
  const decoded = decodeChunkFrame(encoded);
  assert.equal(decoded.taskId, taskId);
  assert.equal(decoded.relativePath, 'docs/readme.md');
  assert.equal(decoded.offset, 0);
  assert.equal(decoded.plainLength, plaintext.length);
  assert.deepEqual(Buffer.from(decoded.ciphertext), encrypted.ciphertext);
});

test('chunk-frame: parser handles multiple frames in one buffer', () => {
  const taskId = createTaskId();
  const frame1 = encodeChunkFrame({
    taskId, relativePath: 'a.txt', offset: 0, sequence: 0, plainLength: 0,
    nonce: Buffer.alloc(12), authTag: Buffer.alloc(16), ciphertext: Buffer.alloc(0),
  });
  const frame2 = encodeChunkFrame({
    taskId, relativePath: 'b.txt', offset: 0, sequence: 1, plainLength: 0,
    nonce: Buffer.alloc(12), authTag: Buffer.alloc(16), ciphertext: Buffer.alloc(0),
  });
  const parser = new TransferChunkFrameParser();
  const frames = parser.push(Buffer.concat([frame1, frame2]));
  assert.equal(frames.length, 2);
  assert.equal(frames[0]!.relativePath, 'a.txt');
  assert.equal(frames[1]!.relativePath, 'b.txt');
});

test('message-codec: encode and decode round-trips a decision', () => {
  const now = Date.now();
  const message = {
    app: APP_ID, protocolVersion: PROTOCOL_VERSION, type: TYPE_TRANSFER_DECISION,
    taskId: createTaskId(), sessionId: crypto.randomBytes(16).toString('base64url'),
    senderDeviceId: 'a1b2c3d4e5f60718', receiverDeviceId: '0123456789abcdef',
    decision: 'accepted', issuedAt: now, expiresAt: now + 60000,
    signature: crypto.randomBytes(64).toString('base64url'),
  };
  const encoded = encodeTransferMessage(TYPE_TRANSFER_DECISION, message);
  const decoded = decodeTransferMessage(TYPE_TRANSFER_DECISION, encoded);
  assert.equal(decoded.decision, 'accepted');
  assert.equal(decoded.taskId, message.taskId);
});

test('message-codec: rejects expired messages', () => {
  const past = Date.now() - 120000;
  const message = {
    app: APP_ID, protocolVersion: PROTOCOL_VERSION, type: TYPE_TRANSFER_DECISION,
    taskId: createTaskId(), sessionId: crypto.randomBytes(16).toString('base64url'),
    senderDeviceId: 'a1b2c3d4e5f60718', receiverDeviceId: '0123456789abcdef',
    decision: 'accepted', issuedAt: past - 60000, expiresAt: past,
    signature: crypto.randomBytes(64).toString('base64url'),
  };
  assert.throws(() => validateTransferMessage(TYPE_TRANSFER_DECISION, message), /expired/);
});

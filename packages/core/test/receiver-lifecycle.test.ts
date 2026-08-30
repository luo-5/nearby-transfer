import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';

import {
  APP_ID,
  MESSAGE_TYPES,
  PROTOCOL_VERSION,
  RESERVATION_ROOT_NAME,
  STAGING_PREFIX,
  STAGING_SUFFIX,
  TYPE_TRANSFER_MANIFEST,
  createEd25519KeyPair,
  createTransferManifest,
  createTransferReceiver,
  createX25519KeyPair,
  deriveDeviceId,
  encodeTransferMessage,
  encodeWireFrame,
  signTransferMessage,
} from '../src/index.js';

test('transfer receiver aborts bootstrap promptly and removes stream listeners', async () => {
  const stream = new PassThrough();
  const controller = new AbortController();
  const pending = createTransferReceiver({
    socket: stream as never,
    receiveDir: process.cwd(),
    localDeviceId: '0123456789abcdef',
    localSigningPrivateKey: 'unused-during-bootstrap',
    localEncryptionPrivateKey: 'unused-during-bootstrap',
    lookupPeer: () => null,
    signal: controller.signal,
  });
  controller.abort(new Error('test cancellation'));
  await assert.rejects(pending, (error: Error) => error.name === 'AbortError');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stream.listenerCount('data'), 0);
  assert.equal(stream.listenerCount('error'), 0);
  assert.equal(stream.listenerCount('close'), 0);
  assert.equal(stream.destroyed, true);
});

test('transfer receiver closes the stream when the first manifest payload cannot be decoded', async () => {
  const stream = new PassThrough();
  const pending = createTransferReceiver({
    socket: stream as never,
    receiveDir: process.cwd(),
    localDeviceId: '0123456789abcdef',
    localSigningPrivateKey: 'unused-for-invalid-manifest',
    localEncryptionPrivateKey: 'unused-for-invalid-manifest',
    lookupPeer: () => null,
  });

  stream.write(encodeWireFrame({
    header: {
      app: APP_ID,
      protocolVersion: PROTOCOL_VERSION,
      type: MESSAGE_TYPES.TRANSFER_MANIFEST,
    },
    payload: Buffer.from('{}'),
  }));

  await assert.rejects(pending, /Transfer manifest envelope/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stream.listenerCount('data'), 0);
  assert.equal(stream.listenerCount('error'), 0);
  assert.equal(stream.listenerCount('close'), 0);
  assert.equal(stream.destroyed, true);
});

test('transfer receiver cancels bootstrap ownership and removes staging when session handoff fails', async () => {
  const receiveDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nearby-transfer-receiver-'));
  const fixture = createManifestFixture();
  const stream = new PassThrough();
  stream.unshift = (() => {
    throw new Error('deterministic session handoff failure');
  }) as typeof stream.unshift;

  try {
    const pending = createTransferReceiver({
      socket: stream as never,
      receiveDir,
      localDeviceId: fixture.receiverDeviceId,
      localSigningPrivateKey: fixture.receiverSigning.privateKey,
      localEncryptionPrivateKey: fixture.receiverEncryption.privateKey,
      lookupPeer: (deviceId) => deviceId === fixture.senderDeviceId
        ? { signingPublicKey: fixture.senderSigning.publicKey }
        : null,
    });

    // The extra byte is retained after the manifest and forces the deterministic
    // handoff hook only after planning and writer creation have completed.
    stream.write(Buffer.concat([fixture.frame, Buffer.from([0])]));
    await assert.rejects(pending, /deterministic session handoff failure/);
    await new Promise((resolve) => setImmediate(resolve));

    const stagingDirectory = path.join(
      receiveDir,
      `${STAGING_PREFIX}${fixture.manifest.taskId}${STAGING_SUFFIX}`,
    );
    await assert.rejects(fs.lstat(stagingDirectory), (error: NodeJS.ErrnoException) => error.code === 'ENOENT');
    await assert.rejects(
      fs.lstat(path.join(receiveDir, RESERVATION_ROOT_NAME)),
      (error: NodeJS.ErrnoException) => error.code === 'ENOENT',
    );
    assert.equal(stream.listenerCount('data'), 0);
    assert.equal(stream.listenerCount('error'), 0);
    assert.equal(stream.listenerCount('close'), 0);
    assert.equal(stream.destroyed, true);
  } finally {
    await fs.rm(receiveDir, { recursive: true, force: true });
  }
});

function createManifestFixture() {
  const now = Date.now();
  const senderSigning = createEd25519KeyPair();
  const receiverSigning = createEd25519KeyPair();
  const senderEncryption = createX25519KeyPair();
  const receiverEncryption = createX25519KeyPair();
  const senderDeviceId = deriveDeviceId(senderSigning.publicKey);
  const receiverDeviceId = deriveDeviceId(receiverSigning.publicKey);
  const manifest = createTransferManifest({
    entries: [{
      kind: 'file',
      path: 'empty.txt',
      size: 0,
      sha256: crypto.createHash('sha256').digest('hex'),
    }],
  });
  const senderEphemeralPublicKey = Buffer.from(crypto.createPublicKey(senderEncryption.publicKey)
    .export({ type: 'spki', format: 'der' })).subarray(-32).toString('base64url');
  const signed = signTransferMessage(TYPE_TRANSFER_MANIFEST, {
    app: APP_ID,
    protocolVersion: PROTOCOL_VERSION,
    type: TYPE_TRANSFER_MANIFEST,
    manifest,
    senderDeviceId,
    receiverDeviceId,
    senderEphemeralPublicKey,
    sessionId: crypto.randomBytes(16).toString('base64url'),
    issuedAt: now,
    expiresAt: now + 30_000,
  }, senderSigning.privateKey, { now });
  const frame = encodeWireFrame({
    header: {
      app: APP_ID,
      protocolVersion: PROTOCOL_VERSION,
      type: MESSAGE_TYPES.TRANSFER_MANIFEST,
    },
    payload: encodeTransferMessage(TYPE_TRANSFER_MANIFEST, signed, { now }),
  });
  return {
    frame,
    manifest,
    senderDeviceId,
    receiverDeviceId,
    senderSigning,
    receiverSigning,
    receiverEncryption,
  };
}

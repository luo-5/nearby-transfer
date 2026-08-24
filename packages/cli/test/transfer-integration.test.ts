/**
 * CLI transfer unit tests — verifies manifest building, device creation,
 parameter parsing, and file validation. Full end-to-end TCP transfer
 requires a bootstrap-to-stream-session handoff that is still under
 development (see KNOWN_ISSUES below); these tests verify the components
 that can be tested in isolation.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

import {
  createEd25519KeyPair,
  createX25519KeyPair,
  deriveDeviceId,
  fingerprintFor,
  buildTransferSourceManifest,
  normalizeTransferManifest,
  serializeTransferManifest,
  JOB_DIRECTION,
  JOB_STATUS,
} from '@luo-5/core';

// KNOWN_ISSUES: Full in-process end-to-end transfer (sender → receiver over TCP)
// is not yet passing because the bootstrap-to-stream-session handoff on the same
// TCP socket has a data buffering issue. The bootstrap receives the decision
// wire frame and succeeds, but the receiver's subsequent MUX stream-hello frame
// arrives before the sender's stream session attaches its data listener, and
// Node.js's socket pause/resume mechanism doesn't reliably buffer the data.
// The individual components (manifest, crypto, executor, receiver) are verified
// by the core test suite (67 tests). The end-to-end flow will be fixed in a
// future iteration by using a dedicated handoff buffer or a two-connection
// approach.

interface TestDevice {
  deviceId: string;
  deviceName: string;
  fingerprint: string;
  signingPublicKey: string;
  signingPrivateKey: string;
  encryptionPublicKey: string;
  encryptionPrivateKey: string;
}

function createTestDevice(name: string): TestDevice {
  const signing = createEd25519KeyPair();
  const encryption = createX25519KeyPair();
  const deviceId = deriveDeviceId(signing.publicKey);
  return {
    deviceId,
    deviceName: name,
    fingerprint: fingerprintFor(signing.publicKey),
    signingPublicKey: signing.publicKey,
    signingPrivateKey: signing.privateKey,
    encryptionPublicKey: encryption.publicKey,
    encryptionPrivateKey: encryption.privateKey,
  };
}

test('unit: buildTransferSourceManifest builds a valid manifest from files', async () => {
  const tempDir = join(tmpdir(), `nt-unit-manifest-${Date.now()}`);
  mkdirSync(tempDir, { recursive: true });
  const filePath = join(tempDir, 'test.txt');
  const content = 'hello manifest test';
  writeFileSync(filePath, content);
  const expectedSha = createHash('sha256').update(content).digest('hex');

  try {
    const sm = await buildTransferSourceManifest([filePath]);
    assert.ok(sm.manifest.taskId, 'Manifest must have a taskId');
    assert.match(sm.manifest.taskId, /^[A-Za-z0-9_-]{22}$/, 'taskId must be 22-char base64url');
    assert.equal(sm.manifest.conflictStrategy, 'auto-rename');
    assert.equal(sm.files.length, 1, 'Must have one file');
    assert.equal(sm.files[0]!.path, 'test.txt', 'File path must be the basename');
    assert.equal(sm.files[0]!.size, content.length, 'File size must match');
    assert.equal(sm.files[0]!.sha256, expectedSha, 'SHA-256 must match');
    assert.equal(sm.manifest.totalFiles, 1);
    assert.equal(sm.manifest.totalBytes, content.length);
    // Manifest must be normalizable (passes strict validation)
    const normalized = normalizeTransferManifest(sm.manifest);
    assert.equal(normalized.taskId, sm.manifest.taskId);
    // Serialization must produce canonical JSON
    const serialized = serializeTransferManifest(sm.manifest);
    assert.ok(serialized.includes('"taskId"'), 'Serialized manifest must contain taskId');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('unit: device identities are consistent and distinct', () => {
  const sender = createTestDevice('sender');
  const receiver = createTestDevice('receiver');

  assert.match(sender.deviceId, /^[a-f0-9]{16}$/, 'sender deviceId must be 16 hex');
  assert.match(receiver.deviceId, /^[a-f0-9]{16}$/, 'receiver deviceId must be 16 hex');
  assert.notEqual(sender.deviceId, receiver.deviceId, 'Devices must differ');
  assert.match(sender.fingerprint, /^[0-9A-F]{4}(?:-[0-9A-F]{4}){5}$/, 'fingerprint format');
  assert.notEqual(sender.fingerprint, receiver.fingerprint, 'Fingerprints must differ');
  assert.ok(sender.signingPublicKey.includes('BEGIN PUBLIC KEY'), 'signing key is PEM');
  assert.ok(sender.encryptionPublicKey.includes('BEGIN PUBLIC KEY'), 'encryption key is PEM');
  assert.ok(sender.signingPrivateKey.includes('BEGIN PRIVATE KEY'), 'signing private key is PEM');
  assert.ok(sender.encryptionPrivateKey.includes('BEGIN PRIVATE KEY'), 'encryption private key is PEM');
  // Re-deriving deviceId from the public key must match
  const reDerived = deriveDeviceId(sender.signingPublicKey);
  assert.equal(reDerived, sender.deviceId, 'deviceId must be consistent with signing public key');
});

test('unit: job constants are correct for outgoing transfers', () => {
  assert.equal(JOB_DIRECTION.OUTGOING, 'outgoing');
  assert.equal(JOB_DIRECTION.INCOMING, 'incoming');
  assert.equal(JOB_STATUS.TRANSFERRING, 'transferring');
  assert.equal(JOB_STATUS.QUEUED, 'queued');
  assert.equal(JOB_STATUS.COMPLETED, 'completed');
});

test('unit: multiple files produce correct manifest with total counts', async () => {
  const tempDir = join(tmpdir(), `nt-unit-multi-${Date.now()}`);
  mkdirSync(tempDir, { recursive: true });
  const file1 = join(tempDir, 'a.txt');
  const file2 = join(tempDir, 'b.txt');
  writeFileSync(file1, 'content a');
  writeFileSync(file2, 'content bb');

  try {
    const sm = await buildTransferSourceManifest([file1, file2]);
    assert.equal(sm.files.length, 2, 'Must have two files');
    assert.equal(sm.manifest.totalFiles, 2);
    assert.equal(sm.manifest.totalBytes, 'content a'.length + 'content bb'.length);
    // Entries must be sorted by path
    assert.equal(sm.manifest.entries[0]!.path, 'a.txt');
    assert.equal(sm.manifest.entries[1]!.path, 'b.txt');
    // Each file's SHA-256 must match
    const hash1 = createHash('sha256').update('content a').digest('hex');
    const hash2 = createHash('sha256').update('content bb').digest('hex');
    assert.equal(sm.files[0]!.sha256, hash1);
    assert.equal(sm.files[1]!.sha256, hash2);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('unit: createTransferReceiver input validation rejects bad parameters', async () => {
  const { createTransferReceiver } = await import('@luo-5/core');
  const tempDir = join(tmpdir(), `nt-unit-recv-${Date.now()}`);
  mkdirSync(tempDir, { recursive: true });
  const device = createTestDevice('test');

  // Missing socket
  await assert.rejects(() => createTransferReceiver({
    socket: null as never,
    receiveDir: tempDir,
    localDeviceId: device.deviceId,
    localSigningPrivateKey: device.signingPrivateKey,
    localEncryptionPrivateKey: device.encryptionPrivateKey,
    lookupPeer: () => null,
  }), /socket/i);

  // Missing receiveDir (valid socket mock to reach the receiveDir check)
  await assert.rejects(() => createTransferReceiver({
    socket: { write: () => {} } as never,
    receiveDir: '',
    localDeviceId: device.deviceId,
    localSigningPrivateKey: device.signingPrivateKey,
    localEncryptionPrivateKey: device.encryptionPrivateKey,
    lookupPeer: () => null,
  }), /receive directory/i);

  // Invalid deviceId
  await assert.rejects(() => createTransferReceiver({
    socket: { write: () => {} } as never,
    receiveDir: tempDir,
    localDeviceId: 'bad',
    localSigningPrivateKey: device.signingPrivateKey,
    localEncryptionPrivateKey: device.encryptionPrivateKey,
    lookupPeer: () => null,
  }), /device ID/i);

  // Missing lookupPeer
  await assert.rejects(() => createTransferReceiver({
    socket: { write: () => {} } as never,
    receiveDir: tempDir,
    localDeviceId: device.deviceId,
    localSigningPrivateKey: device.signingPrivateKey,
    localEncryptionPrivateKey: device.encryptionPrivateKey,
    lookupPeer: undefined as never,
  }), /lookupPeer/i);

  rmSync(tempDir, { recursive: true, force: true });
});

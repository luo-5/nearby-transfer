/**
 * CLI transfer tests — unit tests for manifest/device validation plus a
 * real end-to-end TCP transfer test that verifies SHA-256 file integrity.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomFillSync } from 'node:crypto';
import net from 'node:net';

import {
  createEd25519KeyPair,
  createX25519KeyPair,
  deriveDeviceId,
  fingerprintFor,
  buildTransferSourceManifest,
  normalizeTransferManifest,
  serializeTransferManifest,
  createDesktopTransferExecutor,
  createTransferReceiver,
  JOB_DIRECTION,
  JOB_STATUS,
} from '@luo-5/core';

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

// ─── Unit tests ───────────────────────────────────────────

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
    const normalized = normalizeTransferManifest(sm.manifest);
    assert.equal(normalized.taskId, sm.manifest.taskId);
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
    assert.equal(sm.manifest.entries[0]!.path, 'a.txt');
    assert.equal(sm.manifest.entries[1]!.path, 'b.txt');
    const hash1 = createHash('sha256').update('content a').digest('hex');
    const hash2 = createHash('sha256').update('content bb').digest('hex');
    assert.equal(sm.files[0]!.sha256, hash1);
    assert.equal(sm.files[1]!.sha256, hash2);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('unit: createTransferReceiver input validation rejects bad parameters', async () => {
  const tempDir = join(tmpdir(), `nt-unit-recv-${Date.now()}`);
  mkdirSync(tempDir, { recursive: true });
  const device = createTestDevice('test');

  await assert.rejects(() => createTransferReceiver({
    socket: null as never,
    receiveDir: tempDir,
    localDeviceId: device.deviceId,
    localSigningPrivateKey: device.signingPrivateKey,
    localEncryptionPrivateKey: device.encryptionPrivateKey,
    lookupPeer: () => null,
  }), /socket/i);

  await assert.rejects(() => createTransferReceiver({
    socket: { write: () => {} } as never,
    receiveDir: '',
    localDeviceId: device.deviceId,
    localSigningPrivateKey: device.signingPrivateKey,
    localEncryptionPrivateKey: device.encryptionPrivateKey,
    lookupPeer: () => null,
  }), /receive directory/i);

  await assert.rejects(() => createTransferReceiver({
    socket: { write: () => {} } as never,
    receiveDir: tempDir,
    localDeviceId: 'bad',
    localSigningPrivateKey: device.signingPrivateKey,
    localEncryptionPrivateKey: device.encryptionPrivateKey,
    lookupPeer: () => null,
  }), /device ID/i);

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

// ─── End-to-end transfer test ─────────────────────────────

test('e2e: sender → receiver transfers a 256 KB file with correct SHA-256', async () => {
  const sender = createTestDevice('sender');
  const receiver = createTestDevice('receiver');

  const tmpBase = mkdtempSync(join(realpathSync(tmpdir()), 'nt-e2e-'));
  const sendDir = join(tmpBase, 'send');
  const recvDir = join(tmpBase, 'recv');
  mkdirSync(sendDir, { recursive: true });
  mkdirSync(recvDir, { recursive: true });

  const filePath = join(sendDir, 'test.bin');
  const content = Buffer.alloc(256 * 1024);
  randomFillSync(content);
  writeFileSync(filePath, content);
  const expectedHash = createHash('sha256').update(content).digest('hex');

  try {
    const sm = await buildTransferSourceManifest([filePath]);

    const trustedPeers = new Map<string, { signingPublicKey: string; deviceName?: string }>([
      [sender.deviceId, { signingPublicKey: sender.signingPublicKey, deviceName: sender.deviceName }],
    ]);

    const receiverTasks: Promise<void>[] = [];
    const server = net.createServer((socket) => {
      socket.setNoDelay(true);
      const receiverTask = createTransferReceiver({
        socket,
        receiveDir: recvDir,
        localDeviceId: receiver.deviceId,
        localSigningPrivateKey: receiver.signingPrivateKey,
        localEncryptionPrivateKey: receiver.encryptionPrivateKey,
        lookupPeer: (deviceId: string) => trustedPeers.get(deviceId) ?? null,
      }).then((recv) => recv.done).catch((error) => {
        socket.destroy();
        throw error;
      });
      receiverTask.catch(() => {});
      receiverTasks.push(receiverTask);
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as net.AddressInfo).port;

    try {
      const controller = new AbortController();
      const totalBytes = sm.files.reduce((sum, f) => sum + f.size, 0);
      const checkpoint = {
        files: sm.files.map((f) => ({ path: f.path, size: f.size, committedOffset: 0, completed: false })),
        nextSequence: 0,
        totalTransferred: 0,
      };
      const executor = await createDesktopTransferExecutor({
        job: {
          taskId: sm.manifest.taskId,
          peerDeviceId: receiver.deviceId,
          direction: JOB_DIRECTION.OUTGOING,
          status: JOB_STATUS.TRANSFERRING,
          manifest: sm.manifest,
          sources: sm.files,
          sourceMappingStatus: 'available',
          progress: { transferredBytes: 0, totalBytes },
        } as never,
        checkpoint,
        signal: controller.signal,
        commitRemoteCheckpoint: (cp) => cp,
        localDevice: {
          deviceId: sender.deviceId,
          signingPrivateKey: sender.signingPrivateKey,
        },
        trustedPeerStore: {
          getTrustedPeer: () => ({
            identity: {
              deviceId: receiver.deviceId,
              deviceName: receiver.deviceName,
              fingerprint: receiver.fingerprint,
              signingPublicKey: receiver.signingPublicKey,
              encryptionPublicKey: receiver.encryptionPublicKey,
            },
            permissions: { transfer: true },
            revokedAt: null,
          }),
        },
        lanService: {
          listPeers: () => [{
            deviceId: receiver.deviceId,
            deviceName: receiver.deviceName,
            fingerprint: receiver.fingerprint,
            signingPublicKey: receiver.signingPublicKey,
            encryptionPublicKey: receiver.encryptionPublicKey,
            host: '127.0.0.1',
            port,
          }],
        },
      });

      await executor.done;
      await Promise.all(receiverTasks);
    } finally {
      server.close();
    }

    const receivedPath = join(recvDir, 'test.bin');
    const receivedContent = readFileSync(receivedPath);
    const receivedHash = createHash('sha256').update(receivedContent).digest('hex');
    assert.equal(receivedHash, expectedHash, 'Received file SHA-256 must match the original');
  } finally {
    rmSync(tmpBase, { recursive: true, force: true });
  }
});

test('e2e: multiple files transfer with correct sizes and hashes', async () => {
  const sender = createTestDevice('sender');
  const receiver = createTestDevice('receiver');

  const tmpBase = mkdtempSync(join(realpathSync(tmpdir()), 'nt-e2e-multi-'));
  const sendDir = join(tmpBase, 'send');
  const recvDir = join(tmpBase, 'recv');
  mkdirSync(sendDir, { recursive: true });
  mkdirSync(recvDir, { recursive: true });

  const fileA = join(sendDir, 'a.bin');
  const fileB = join(sendDir, 'b.bin');
  const contentA = Buffer.alloc(64 * 1024);
  const contentB = Buffer.alloc(128 * 1024);
  randomFillSync(contentA);
  randomFillSync(contentB);
  writeFileSync(fileA, contentA);
  writeFileSync(fileB, contentB);
  const hashA = createHash('sha256').update(contentA).digest('hex');
  const hashB = createHash('sha256').update(contentB).digest('hex');

  try {
    const sm = await buildTransferSourceManifest([fileA, fileB]);

    const trustedPeers = new Map<string, { signingPublicKey: string; deviceName?: string }>([
      [sender.deviceId, { signingPublicKey: sender.signingPublicKey, deviceName: sender.deviceName }],
    ]);

    const receiverTasks: Promise<void>[] = [];
    const server = net.createServer((socket) => {
      socket.setNoDelay(true);
      const receiverTask = createTransferReceiver({
        socket,
        receiveDir: recvDir,
        localDeviceId: receiver.deviceId,
        localSigningPrivateKey: receiver.signingPrivateKey,
        localEncryptionPrivateKey: receiver.encryptionPrivateKey,
        lookupPeer: (deviceId: string) => trustedPeers.get(deviceId) ?? null,
      }).then((recv) => recv.done).catch((error) => {
        socket.destroy();
        throw error;
      });
      receiverTask.catch(() => {});
      receiverTasks.push(receiverTask);
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as net.AddressInfo).port;

    try {
      const controller = new AbortController();
      const totalBytes = sm.files.reduce((sum, f) => sum + f.size, 0);
      const checkpoint = {
        files: sm.files.map((f) => ({ path: f.path, size: f.size, committedOffset: 0, completed: false })),
        nextSequence: 0,
        totalTransferred: 0,
      };
      const executor = await createDesktopTransferExecutor({
        job: {
          taskId: sm.manifest.taskId,
          peerDeviceId: receiver.deviceId,
          direction: JOB_DIRECTION.OUTGOING,
          status: JOB_STATUS.TRANSFERRING,
          manifest: sm.manifest,
          sources: sm.files,
          sourceMappingStatus: 'available',
          progress: { transferredBytes: 0, totalBytes },
        } as never,
        checkpoint,
        signal: controller.signal,
        commitRemoteCheckpoint: (cp) => cp,
        localDevice: {
          deviceId: sender.deviceId,
          signingPrivateKey: sender.signingPrivateKey,
        },
        trustedPeerStore: {
          getTrustedPeer: () => ({
            identity: {
              deviceId: receiver.deviceId,
              deviceName: receiver.deviceName,
              fingerprint: receiver.fingerprint,
              signingPublicKey: receiver.signingPublicKey,
              encryptionPublicKey: receiver.encryptionPublicKey,
            },
            permissions: { transfer: true },
            revokedAt: null,
          }),
        },
        lanService: {
          listPeers: () => [{
            deviceId: receiver.deviceId,
            deviceName: receiver.deviceName,
            fingerprint: receiver.fingerprint,
            signingPublicKey: receiver.signingPublicKey,
            encryptionPublicKey: receiver.encryptionPublicKey,
            host: '127.0.0.1',
            port,
          }],
        },
      });

      await executor.done;
      await Promise.all(receiverTasks);
    } finally {
      server.close();
    }

    const recvA = readFileSync(join(recvDir, 'a.bin'));
    const recvB = readFileSync(join(recvDir, 'b.bin'));
    assert.equal(createHash('sha256').update(recvA).digest('hex'), hashA, 'File a SHA-256 mismatch');
    assert.equal(createHash('sha256').update(recvB).digest('hex'), hashB, 'File b SHA-256 mismatch');
  } finally {
    rmSync(tmpBase, { recursive: true, force: true });
  }
});

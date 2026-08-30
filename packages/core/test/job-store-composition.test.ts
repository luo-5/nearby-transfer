import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createDesktopTransferExecutor,
  createDesktopTransferScheduler,
  createEd25519KeyPair,
  createTransferManifest,
  createX25519KeyPair,
  deriveDeviceId,
  DIAGNOSTIC_CODE,
  JOB_STATUS,
  SOURCE_MAPPING_STATUS,
  TransferJobStore,
} from '../src/index.js';

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'nearby-core-job-store-'));
  const sourcePath = join(directory, 'payload.txt');
  const payload = Buffer.from('store-scheduler-executor composition');
  writeFileSync(sourcePath, payload);
  const sha256 = crypto.createHash('sha256').update(payload).digest('hex');
  const manifest = createTransferManifest({
    entries: [{ kind: 'file', path: 'payload.txt', size: payload.length, sha256 }],
  });
  const remoteSigning = createEd25519KeyPair();
  const remoteEncryption = createX25519KeyPair();
  const localSigning = createEd25519KeyPair();
  return {
    directory,
    sourcePath,
    payload,
    sha256,
    manifest,
    peerDeviceId: deriveDeviceId(remoteSigning.publicKey),
    localDeviceId: deriveDeviceId(localSigning.publicKey),
    remoteSigning,
    remoteEncryption,
    localSigning,
  };
}

async function waitForJobStatus(store: TransferJobStore, taskId: string, expectedStatus: string): Promise<void> {
  for (let turn = 0; turn < 100; turn += 1) {
    if (store.get(taskId)?.status === expectedStatus) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail(`transfer job did not reach ${expectedStatus}`);
}

test('job store creates the complete outgoing runtime contract and persists checkpoint progress', () => {
  const data = fixture();
  try {
    const store = new TransferJobStore(data.directory, { getTrustedPeer: () => ({}) });
    const queued = store.queueOutgoing({
      peerDeviceId: data.peerDeviceId,
      manifest: data.manifest,
      sources: [{ path: 'payload.txt', sourcePath: data.sourcePath, size: data.payload.length, sha256: data.sha256 }],
    });

    assert.equal(queued.sourceMappingStatus, SOURCE_MAPPING_STATUS.AVAILABLE);
    assert.equal(queued.recoverable, true);
    assert.deepEqual(queued.progress, {
      totalFiles: 1,
      completedFiles: 0,
      totalBytes: data.payload.length,
      transferredBytes: 0,
    });
    assert.deepEqual(store.getOutgoingCheckpoint(queued.taskId), {
      files: [{ path: 'payload.txt', size: data.payload.length, committedOffset: 0, completed: false }],
      nextSequence: 0,
      totalTransferred: 0,
    });

    store.start(queued.taskId);
    const advanced = store.advanceOutgoingCheckpoint(queued.taskId, {
      files: [{ path: 'payload.txt', size: data.payload.length, committedOffset: data.payload.length, completed: true }],
      nextSequence: 1,
      totalTransferred: data.payload.length,
    });
    assert.equal(advanced.progress.transferredBytes, data.payload.length);
    assert.equal(advanced.progress.completedFiles, 1);
    assert.equal(store.complete(queued.taskId).status, JOB_STATUS.COMPLETED);

    store.close();
    const reopened = new TransferJobStore(data.directory, { getTrustedPeer: () => ({}) });
    assert.equal(reopened.get(queued.taskId)?.sourceMappingStatus, SOURCE_MAPPING_STATUS.AVAILABLE);
    assert.equal(reopened.get(queued.taskId)?.progress.transferredBytes, data.payload.length);
  } finally {
    rmSync(data.directory, { recursive: true, force: true });
  }
});

test('store, scheduler, and executor compose without a hidden job-shape failure', async () => {
  const data = fixture();
  try {
    const store = new TransferJobStore(data.directory, { getTrustedPeer: () => ({}) });
    const queued = store.queueOutgoing({
      peerDeviceId: data.peerDeviceId,
      manifest: data.manifest,
      sources: [{ path: 'payload.txt', sourcePath: data.sourcePath, size: data.payload.length, sha256: data.sha256 }],
    });
    const trustedPeer = {
      identity: {
        deviceId: data.peerDeviceId,
        deviceName: 'Regression peer',
        fingerprint: 'regression-peer',
        signingPublicKey: data.remoteSigning.publicKey,
        encryptionPublicKey: data.remoteEncryption.publicKey,
      },
      permissions: { transfer: true },
      revokedAt: null,
    };
    const discoveredPeer = {
      ...trustedPeer.identity,
      host: '127.0.0.1',
      port: 65535,
    };

    const scheduler = createDesktopTransferScheduler({
      transferJobStore: store,
      executorFactory: (args) => createDesktopTransferExecutor({
        ...args,
        localDevice: {
          deviceId: data.localDeviceId,
          signingPrivateKey: data.localSigning.privateKey,
        },
        trustedPeerStore: { getTrustedPeer: () => trustedPeer },
        lanService: { listPeers: () => [discoveredPeer] },
        connector: async () => {
          throw new Error('intentional local connector stop');
        },
      }),
    });

    await scheduler.start();
    await waitForJobStatus(store, queued.taskId, JOB_STATUS.FAILED);
    const failed = store.get(queued.taskId)!;
    assert.equal(failed.status, JOB_STATUS.FAILED);
    assert.equal(failed.diagnosticCode, DIAGNOSTIC_CODE.NETWORK_INTERRUPTED);
    assert.match(failed.errorMessage ?? '', /connect/i);
    assert.doesNotMatch(failed.errorMessage ?? '', /job|source file mapping|checkpoint/i);
  } finally {
    rmSync(data.directory, { recursive: true, force: true });
  }
});

test('job completion requires zero-byte files to be explicitly committed', () => {
  const directory = mkdtempSync(join(tmpdir(), 'nearby-core-zero-byte-'));
  const sourcePath = join(directory, 'empty.txt');
  writeFileSync(sourcePath, Buffer.alloc(0));
  const sha256 = crypto.createHash('sha256').digest('hex');
  const manifest = createTransferManifest({
    entries: [{ kind: 'file', path: 'empty.txt', size: 0, sha256 }],
  });
  try {
    const store = new TransferJobStore(directory, { getTrustedPeer: () => ({}) });
    const queued = store.queueOutgoing({
      peerDeviceId: 'zero-byte-peer',
      manifest,
      sources: [{ path: 'empty.txt', sourcePath, size: 0, sha256 }],
    });
    store.start(queued.taskId);
    assert.throws(() => store.complete(queued.taskId), /every manifest file/);
    store.advanceOutgoingCheckpoint(queued.taskId, {
      files: [{ path: 'empty.txt', size: 0, committedOffset: 0, completed: true }],
      nextSequence: 1,
      totalTransferred: 0,
    });
    assert.equal(store.complete(queued.taskId).status, JOB_STATUS.COMPLETED);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('recoverable listing and retry respect the recoverable flag', () => {
  const data = fixture();
  try {
    const store = new TransferJobStore(data.directory, { getTrustedPeer: () => ({}) });
    const queued = store.queueOutgoing({
      peerDeviceId: data.peerDeviceId,
      manifest: data.manifest,
      sources: [{ path: 'payload.txt', sourcePath: data.sourcePath, size: data.payload.length, sha256: data.sha256 }],
    });
    store.fail(queued.taskId, DIAGNOSTIC_CODE.IO_ERROR);
    const internal = (store as unknown as { jobs: Map<string, { recoverable: boolean }> }).jobs.get(queued.taskId)!;
    internal.recoverable = false;
    assert.deepEqual(store.listRecoverable(), []);
    assert.throws(() => store.retry(queued.taskId), /not recoverable/);
  } finally {
    rmSync(data.directory, { recursive: true, force: true });
  }
});

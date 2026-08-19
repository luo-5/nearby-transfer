'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createKeyPair, createX25519KeyPair, fingerprintFor } = require('../src/core/crypto');
const { createTransferManifest } = require('../src/v2/transfer-manifest');
const { TrustedPeerStore } = require('../src/v2/trusted-peer-store');
const {
  DIAGNOSTIC_CODE,
  JOB_STATUS,
  TransferJobStore
} = require('../src/v2/transfer-job-store');

const TASK_A = 'AQIDBAUGBwgJCgsMDQ4PEA';
const TASK_B = 'ERITFBUWFxgZGhscHR4fIA';
const TASK_C = 'ISIjJCUmJygpKissLS4vMA';
const TASK_D = Buffer.alloc(16, 4).toString('base64url');
const TASK_E = Buffer.alloc(16, 5).toString('base64url');
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

function createIdentity(name) {
  const signing = createKeyPair('ed25519');
  const encryption = createX25519KeyPair();
  return {
    deviceId: crypto.createHash('sha256').update(signing.publicKey).digest('hex').slice(0, 16),
    deviceName: name,
    fingerprint: fingerprintFor(signing.publicKey),
    signingPublicKey: signing.publicKey,
    encryptionPublicKey: encryption.publicKey
  };
}

function manifest(taskId) {
  return createTransferManifest({
    taskId,
    entries: [
      { kind: 'directory', path: 'photos' },
      { kind: 'file', path: 'photos/one.jpg', size: 5, sha256: HASH_A },
      { kind: 'file', path: 'photos/two.jpg', size: 7, sha256: HASH_B },
      { kind: 'file', path: 'empty.txt', size: 0, sha256: HASH_A }
    ]
  });
}

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nearby-transfer-job-store-'));
let peers;
let jobs;
let reopened;
try {
  peers = new TrustedPeerStore(tempDir);
  const peer = createIdentity('Transfer peer');
  peers.upsertTrustedPeer({ identity: peer, permissions: { transfer: true } });
  jobs = new TransferJobStore(tempDir, peers);

  const outgoing = jobs.queueOutgoing({ peerDeviceId: peer.deviceId, manifest: manifest(TASK_A), now: 1760000000000 });
  assert.strictEqual(outgoing.direction, 'outgoing');
  assert.strictEqual(outgoing.status, JOB_STATUS.QUEUED);
  assert.strictEqual(outgoing.retryCount, 0);
  assert.strictEqual(outgoing.errorMessage, null);
  assert.deepStrictEqual(outgoing.progress, { totalFiles: 3, completedFiles: 1, totalBytes: 12, transferredBytes: 0 });
  assert.strictEqual(jobs.getFiles(TASK_A)[2].completed, false);
  assert.throws(() => jobs.queueOutgoing({ peerDeviceId: peer.deviceId, manifest: manifest(TASK_A) }), /already exists/);
  assert.throws(() => jobs.queueOutgoing({ peerDeviceId: '0000000000000000', manifest: manifest(TASK_B) }), /not trusted/);
  assert.throws(() => jobs.pause(TASK_A, 1760000000001), /Illegal transfer job transition/);
  assert.throws(() => jobs.start(TASK_A, 1759999999999), /creation time/);

  jobs.start(TASK_A, 1760000000001);
  assert.throws(() => jobs.retry(TASK_A, 1760000000002), /Illegal transfer job transition/);
  assert.throws(() => jobs.complete(TASK_A, 1760000000002), /fully transferred/);
  jobs.recordFileProgress(TASK_A, 'photos/one.jpg', 3, 1760000000003);
  assert.strictEqual(jobs.get(TASK_A).progress.transferredBytes, 3);
  assert.strictEqual(jobs.get(TASK_A).updatedAt, 1760000000003);
  assert.throws(() => jobs.recordFileProgress(TASK_A, 'photos/one.jpg', 2), /monotonic/);
  assert.throws(() => jobs.recordFileProgress(TASK_A, 'photos/missing.jpg', 1), /not declared/);
  assert.throws(() => jobs.recordFileProgress(TASK_A, 'photos/one.jpg', 6), /exceeds/);
  assert.throws(() => jobs.recordFileProgress(TASK_A, 'photos/one.jpg', Number.MAX_SAFE_INTEGER), /exceeds/);
  jobs.recordFileProgress(TASK_A, 'photos/one.jpg', 5, 1760000000004);
  jobs.recordFileProgress(TASK_A, 'photos/two.jpg', 7, 1760000000005);
  const completed = jobs.complete(TASK_A, 1760000000006);
  assert.strictEqual(completed.status, JOB_STATUS.COMPLETED);
  assert.strictEqual(completed.progress.completedFiles, 3);
  assert.throws(() => jobs.retry(TASK_A), /Illegal transfer job transition/);

  const incoming = jobs.receivePending({ peerDeviceId: peer.deviceId, manifest: manifest(TASK_B), now: 1760000000010 });
  assert.strictEqual(incoming.status, JOB_STATUS.AWAITING_APPROVAL);
  assert.throws(() => jobs.start(TASK_B), /Illegal transfer job transition/);
  jobs.approveIncoming(TASK_B, 1760000000011);
  jobs.start(TASK_B, 1760000000012);
  jobs.pause(TASK_B, 1760000000013);
  assert.throws(() => jobs.retry(TASK_B, 1760000000014), /Illegal transfer job transition/);
  assert.throws(() => jobs.recordFileProgress(TASK_B, 'photos/one.jpg', 1), /only be recorded while transferring/);
  jobs.resume(TASK_B, 1760000000014);
  jobs.start(TASK_B, 1760000000015);

  jobs.database.exec(`
    CREATE TEMP TRIGGER force_progress_rollback
    BEFORE UPDATE OF transferred_bytes ON transfer_jobs
    WHEN NEW.task_id = '${TASK_B}'
    BEGIN
      SELECT RAISE(ABORT, 'forced aggregate update failure');
    END;
  `);
  assert.throws(
    () => jobs.recordFileProgress(TASK_B, 'photos/one.jpg', 1, 1760000000015),
    /forced aggregate update failure/
  );
  jobs.database.exec('DROP TRIGGER force_progress_rollback');
  assert.strictEqual(jobs.getFiles(TASK_B).find((file) => file.path === 'photos/one.jpg').transferredBytes, 0);
  assert.strictEqual(jobs.get(TASK_B).progress.transferredBytes, 0);

  jobs.fail(TASK_B, DIAGNOSTIC_CODE.NETWORK_INTERRUPTED, 1760000000016, ' Wi-Fi connection dropped ');
  const failed = jobs.get(TASK_B);
  assert.strictEqual(failed.diagnosticCode, DIAGNOSTIC_CODE.NETWORK_INTERRUPTED);
  assert.strictEqual(failed.errorMessage, 'Wi-Fi connection dropped');
  assert.strictEqual(failed.retryCount, 0);
  assert.throws(() => jobs.resume(TASK_B, 1760000000017), /Illegal transfer job transition/);
  assert.throws(() => jobs.fail(TASK_B, 'raw exception text'), /diagnostic code/);
  assert.throws(
    () => jobs.fail(TASK_B, DIAGNOSTIC_CODE.IO_ERROR, 1760000000017, 'x'.repeat(1025)),
    /1-1024 characters/
  );
  const retried = jobs.retry(TASK_B, 1760000000017);
  assert.strictEqual(retried.diagnosticCode, null);
  assert.strictEqual(retried.errorMessage, null);
  assert.strictEqual(retried.retryCount, 1);
  assert.throws(() => jobs.retry(TASK_B, 1760000000018), /Illegal transfer job transition/);
  assert.strictEqual(jobs.cancel(TASK_B, 1760000000018).status, JOB_STATUS.CANCELLED);
  assert.strictEqual(jobs.cancel(TASK_B), false);

  const recoverable = jobs.queueOutgoing({ peerDeviceId: peer.deviceId, manifest: manifest(TASK_C), now: 1760000000020 });
  jobs.start(recoverable.taskId, 1760000000021);
  jobs.recordFileProgress(TASK_C, 'photos/one.jpg', 4, 1760000000022);

  jobs.queueOutgoing({ peerDeviceId: peer.deviceId, manifest: manifest(TASK_D), now: 1760000000023 });
  jobs.start(TASK_D, 1760000000024);
  jobs.recordFileProgress(TASK_D, 'photos/one.jpg', 2, 1760000000025);
  jobs.database.prepare('UPDATE transfer_jobs SET transferred_bytes = 1 WHERE task_id = ?').run(TASK_D);

  jobs.queueOutgoing({ peerDeviceId: peer.deviceId, manifest: manifest(TASK_E), now: 1760000000026 });
  jobs.database.prepare(`
    UPDATE transfer_job_files SET sha256 = 'corrupt' WHERE task_id = ? AND relative_path = 'photos/one.jpg'
  `).run(TASK_E);

  jobs.close();
  jobs = null;

  reopened = new TransferJobStore(tempDir, peers);
  const afterRestart = reopened.get(TASK_C);
  assert.strictEqual(afterRestart.status, JOB_STATUS.PAUSED);
  assert.strictEqual(afterRestart.diagnosticCode, DIAGNOSTIC_CODE.APP_RESTARTED);
  assert.match(afterRestart.errorMessage, /application restarted/);
  assert.strictEqual(afterRestart.retryCount, 0);
  assert.strictEqual(afterRestart.progress.transferredBytes, 4);
  assert.strictEqual(reopened.listRecoverable().some((job) => job.taskId === TASK_C), true);

  const repairedAggregate = reopened.get(TASK_D);
  assert.strictEqual(repairedAggregate.status, JOB_STATUS.PAUSED);
  assert.strictEqual(repairedAggregate.progress.transferredBytes, 2);
  assert.strictEqual(reopened.get(TASK_E), null);
  const quarantined = reopened.database.prepare(`
    SELECT task_id, snapshot_json, reason FROM transfer_job_corruptions WHERE task_id = ?
  `).get(TASK_E);
  assert.strictEqual(quarantined.task_id, TASK_E);
  assert.match(quarantined.reason, /metadata does not match/);
  assert.doesNotThrow(() => JSON.parse(quarantined.snapshot_json));
  assert.strictEqual(reopened.get(TASK_B).retryCount, 1);

  peers.revokeTrustedPeer(peer.deviceId, 1760000000030);
  assert.throws(() => reopened.resume(TASK_C), /not trusted/);
  assert.strictEqual(reopened.cancel(TASK_C, 1760000000031).status, JOB_STATUS.CANCELLED);
  assert.strictEqual(reopened.list().some((job) => job.taskId === TASK_A), false);
  assert.strictEqual(reopened.list({ includeTerminal: true }).length, 4);
  reopened.close();
  reopened = null;
  peers.close();
  peers = null;

  console.log('transfer job store smoke tests passed');
} finally {
  if (reopened) reopened.close();
  if (jobs) jobs.close();
  if (peers) peers.close();
  fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
}

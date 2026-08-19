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
const { createDesktopTransferScheduler } = require('../src/v2/desktop-transfer-scheduler');

const HASH = 'a'.repeat(64);
const TASK_A = 'AQIDBAUGBwgJCgsMDQ4PEA';
const TASK_B = 'ERITFBUWFxgZGhscHR4fIA';
const TASK_C = 'ISIjJCUmJygpKissLS4vMA';
const TASK_D = 'JCUmJygpKissLS4vMDEyMw';
const TASK_E = 'JSYnKCkqKywtLi8wMTIzNA';
const TASK_F = 'JicpKissLS4vMDEyMzQ1Ng';
const TASK_G = 'KCorLC0uLzAxMjM0NTY3OA';
const TASK_H = 'KywtLi8wMTIzNDU2Nzg5Og';
const TASK_I = 'LC0uLzAxMjM0NTY3ODk6Ow';

function identity(name) {
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

function manifest(taskId, fileName = 'file.txt') {
  return createTransferManifest({
    taskId,
    entries: [{ kind: 'file', path: fileName, size: 1, sha256: HASH }]
  });
}

function sourceMapping(dir, fileName = 'file.txt') {
  return [{
    path: fileName,
    sourcePath: path.join(dir, 'source', fileName),
    size: 1,
    sha256: HASH
  }];
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function eventually(predicate, message = 'condition was not reached') {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(message);
}

function queueOutgoing(jobs, peer, dir, taskId, now) {
  const fileName = `${taskId}.txt`;
  return jobs.queueOutgoing({
    peerDeviceId: peer.deviceId,
    manifest: manifest(taskId, fileName),
    sources: sourceMapping(dir, fileName),
    now
  });
}

async function testQueueAndCompletion(jobs, peer, dir) {
  const firstDone = deferred();
  const secondDone = deferred();
  const started = [];
  const executors = [];
  let closeCalls = 0;
  const scheduler = createDesktopTransferScheduler({
    transferJobStore: jobs,
    executorFactory: async ({ job, reportFileProgress }) => {
      started.push(job.taskId);
      executors.push({ job, reportFileProgress });
      return {
        done: job.taskId === TASK_A ? firstDone.promise : secondDone.promise,
        close: async () => { closeCalls += 1; },
        cancel: async () => {}
      };
    }
  });
  queueOutgoing(jobs, peer, dir, TASK_A, 1760000000001);
  queueOutgoing(jobs, peer, dir, TASK_B, 1760000000002);

  await scheduler.start();
  assert.deepStrictEqual(started, [TASK_A]);
  assert.strictEqual(scheduler.getActiveJob().status, JOB_STATUS.TRANSFERRING);
  assert.strictEqual(jobs.get(TASK_B).status, JOB_STATUS.QUEUED);
  await executors[0].reportFileProgress(`${TASK_A}.txt`, 1);
  firstDone.resolve();
  await eventually(() => started.length === 2, 'the second queued task should start after the first completes');
  assert.strictEqual(jobs.get(TASK_A).status, JOB_STATUS.COMPLETED, JSON.stringify(jobs.get(TASK_A)));
  assert.strictEqual(jobs.get(TASK_B).status, JOB_STATUS.TRANSFERRING);
  await scheduler.cancel(TASK_B);
  assert.strictEqual(closeCalls, 2, 'completed and cancelled executors must both be closed');
  await scheduler.stop();
}

async function testPauseResumeAndSingleKick(jobs, peer, dir) {
  const done = deferred();
  const pauseAck = deferred();
  const resumeAck = deferred();
  let starts = 0;
  let cancels = 0;
  const scheduler = createDesktopTransferScheduler({
    transferJobStore: jobs,
    executorFactory: async () => ({
      done: done.promise,
      pause: () => pauseAck.promise,
      resume: () => resumeAck.promise,
      cancel: async () => { cancels += 1; }
    })
  });
  queueOutgoing(jobs, peer, dir, TASK_C, 1760000000010);
  const originalFactory = scheduler.executorFactory;
  scheduler.executorFactory = async (...args) => {
    starts += 1;
    return originalFactory(...args);
  };
  await Promise.all([scheduler.start(), scheduler.kick(), scheduler.kick()]);
  assert.strictEqual(starts, 1, 'concurrent kick calls must not start duplicate executors');

  const pausing = scheduler.pause(TASK_C);
  await Promise.resolve();
  assert.strictEqual(jobs.get(TASK_C).status, JOB_STATUS.TRANSFERRING);
  pauseAck.resolve();
  await pausing;
  assert.strictEqual(jobs.get(TASK_C).status, JOB_STATUS.PAUSED);

  const resuming = scheduler.resume(TASK_C);
  await Promise.resolve();
  assert.strictEqual(jobs.get(TASK_C).status, JOB_STATUS.PAUSED);
  resumeAck.resolve();
  await resuming;
  assert.strictEqual(jobs.get(TASK_C).status, JOB_STATUS.TRANSFERRING);
  assert.strictEqual(starts, 1, 'resume should reuse the active executor');
  await scheduler.stop();
  assert.strictEqual(cancels, 1);
}

async function testFailureRetryAndLateCompletion(jobs, peer, dir) {
  const firstDone = deferred();
  const secondDone = deferred();
  const started = [];
  let closeCalls = 0;
  const scheduler = createDesktopTransferScheduler({
    transferJobStore: jobs,
    executorFactory: async ({ job }) => {
      started.push(job.taskId);
      return {
        done: job.taskId === TASK_D ? firstDone.promise : secondDone.promise,
        close: async () => { closeCalls += 1; },
        cancel: async () => {}
      };
    }
  });
  queueOutgoing(jobs, peer, dir, TASK_D, 1760000000020);
  await scheduler.start();
  firstDone.reject(Object.assign(new Error('socket timed out'), { code: DIAGNOSTIC_CODE.NETWORK_INTERRUPTED }));
  await eventually(() => jobs.get(TASK_D).status === JOB_STATUS.FAILED);
  assert.strictEqual(jobs.get(TASK_D).diagnosticCode, DIAGNOSTIC_CODE.NETWORK_INTERRUPTED);
  const retried = await scheduler.retry(TASK_D);
  assert.strictEqual(retried.status, JOB_STATUS.QUEUED);
  await eventually(() => started.length === 2);
  firstDone.resolve();
  assert.strictEqual(jobs.get(TASK_D).status, JOB_STATUS.TRANSFERRING);
  await scheduler.cancel(TASK_D);
  assert.strictEqual(jobs.get(TASK_D).status, JOB_STATUS.CANCELLED);
  secondDone.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(jobs.get(TASK_D).status, JOB_STATUS.CANCELLED, 'late completion must not resurrect a cancelled task');
  assert.strictEqual(closeCalls, 2, 'failed and cancelled executors must both be closed');
  await scheduler.stop();
}

async function testStopAndMissingSources(jobs, peer, dir) {
  const done = deferred();
  let factoryCalls = 0;
  let cancelCalls = 0;
  const scheduler = createDesktopTransferScheduler({
    transferJobStore: jobs,
    executorFactory: async () => {
      factoryCalls += 1;
      return { done: done.promise, cancel: async () => { cancelCalls += 1; } };
    }
  });
  const missing = jobs.queueOutgoing({
    peerDeviceId: peer.deviceId,
    manifest: manifest(TASK_E, 'missing.txt'),
    sources: sourceMapping(dir, 'missing.txt'),
    now: 1760000000030
  });
  jobs.database.prepare('DELETE FROM transfer_job_sources WHERE task_id = ?').run(TASK_E);
  jobs.database.prepare('UPDATE transfer_jobs SET source_mapping_version = 0 WHERE task_id = ?').run(TASK_E);
  const missingAfterPersistenceRepair = jobs.get(TASK_E);
  assert.strictEqual(missing.sourceMappingStatus, 'available');
  assert.strictEqual(missingAfterPersistenceRepair.sourceMappingStatus, 'missing');
  queueOutgoing(jobs, peer, dir, TASK_F, 1760000000031);
  await scheduler.start();
  assert.strictEqual(factoryCalls, 1, 'unrecoverable source mappings must not be launched');
  await scheduler.stop();
  assert.strictEqual(cancelCalls, 1);
  assert.strictEqual(jobs.get(TASK_F).status, JOB_STATUS.PAUSED);
}

async function testPauseCompletionRace(jobs, peer, dir) {
  const done = deferred();
  let reportFileProgress;
  let closeCalls = 0;
  const scheduler = createDesktopTransferScheduler({
    transferJobStore: jobs,
    executorFactory: async (context) => {
      reportFileProgress = context.reportFileProgress;
      return {
        done: done.promise,
        pause: async () => {
          done.resolve();
          await Promise.resolve();
        },
        close: async () => { closeCalls += 1; },
        cancel: async () => {}
      };
    }
  });
  queueOutgoing(jobs, peer, dir, TASK_G, 1760000000040);

  await scheduler.start();
  await reportFileProgress(`${TASK_G}.txt`, 1);
  const result = await scheduler.pause(TASK_G);
  assert.strictEqual(result.status, JOB_STATUS.COMPLETED);
  assert.strictEqual(jobs.get(TASK_G).status, JOB_STATUS.COMPLETED);
  assert.strictEqual(scheduler.getActiveJob(), null);
  assert.strictEqual(closeCalls, 1);
  await scheduler.stop();
}

async function testCleanupFailureStillPumps(jobs, peer, dir) {
  const firstDone = deferred();
  const secondDone = deferred();
  const started = [];
  const progress = new Map();
  let firstCloseCalls = 0;
  const scheduler = createDesktopTransferScheduler({
    transferJobStore: jobs,
    executorFactory: async ({ job, reportFileProgress }) => {
      started.push(job.taskId);
      progress.set(job.taskId, reportFileProgress);
      return {
        done: job.taskId === TASK_H ? firstDone.promise : secondDone.promise,
        close: async () => {
          if (job.taskId === TASK_H) {
            firstCloseCalls += 1;
            throw new Error('executor close failed');
          }
        },
        cancel: async () => {}
      };
    }
  });
  queueOutgoing(jobs, peer, dir, TASK_H, 1760000000050);
  queueOutgoing(jobs, peer, dir, TASK_I, 1760000000051);

  await scheduler.start();
  await progress.get(TASK_H)(`${TASK_H}.txt`, 1);
  firstDone.resolve();
  await eventually(() => started.length === 2, 'cleanup failure must not block the next queued task');
  assert.strictEqual(jobs.get(TASK_H).status, JOB_STATUS.COMPLETED);
  assert.strictEqual(firstCloseCalls, 1);
  assert.strictEqual(scheduler.getActiveJob().taskId, TASK_I);
  await scheduler.cancel(TASK_I);
  assert.strictEqual(jobs.get(TASK_I).status, JOB_STATUS.CANCELLED);
  await scheduler.stop();
}

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nearby-transfer-desktop-scheduler-'));
let peers;
let jobs;
async function main() {
  try {
    peers = new TrustedPeerStore(tempDir);
    const peer = identity('Scheduler peer');
    peers.upsertTrustedPeer({ identity: peer, permissions: { transfer: true } });
    jobs = new TransferJobStore(tempDir, peers);
    await testQueueAndCompletion(jobs, peer, tempDir);
    await testPauseResumeAndSingleKick(jobs, peer, tempDir);
    await testFailureRetryAndLateCompletion(jobs, peer, tempDir);
    await testStopAndMissingSources(jobs, peer, tempDir);
    await testPauseCompletionRace(jobs, peer, tempDir);
    await testCleanupFailureStillPumps(jobs, peer, tempDir);
    console.log('desktop transfer scheduler smoke tests passed');
  } finally {
    if (jobs) jobs.close();
    if (peers) peers.close();
    fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

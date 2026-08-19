'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createKeyPair, createX25519KeyPair, fingerprintFor } = require('../src/core/crypto');
const { createTransferManifest, serializeTransferManifest } = require('../src/v2/transfer-manifest');
const { TrustedPeerStore } = require('../src/v2/trusted-peer-store');
const {
  DIAGNOSTIC_CODE,
  JOB_STATUS,
  SOURCE_MAPPING_STATUS,
  TransferJobStore
} = require('../src/v2/transfer-job-store');

const TASK_A = 'AQIDBAUGBwgJCgsMDQ4PEA';
const TASK_B = 'ERITFBUWFxgZGhscHR4fIA';
const TASK_C = 'ISIjJCUmJygpKissLS4vMA';
const TASK_D = Buffer.alloc(16, 4).toString('base64url');
const TASK_E = Buffer.alloc(16, 5).toString('base64url');
const TASK_F = Buffer.alloc(16, 6).toString('base64url');
const TASK_G = Buffer.alloc(16, 7).toString('base64url');
const TASK_H = Buffer.alloc(16, 8).toString('base64url');
const TASK_I = Buffer.alloc(16, 9).toString('base64url');
const TASK_J = Buffer.alloc(16, 10).toString('base64url');
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

function sourceMappings() {
  return [
    { path: 'empty.txt', sourcePath: path.join(tempDir, 'sources', 'empty.txt'), size: 0, sha256: HASH_A },
    { path: 'photos/one.jpg', sourcePath: path.join(tempDir, 'sources', 'one.jpg'), size: 5, sha256: HASH_A },
    { path: 'photos/two.jpg', sourcePath: path.join(tempDir, 'sources', 'two.jpg'), size: 7, sha256: HASH_B }
  ];
}

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nearby-transfer-job-store-'));
let peers;
let jobs;
let reopened;
try {
  peers = new TrustedPeerStore(tempDir);
  const peer = createIdentity('Transfer peer');
  peers.upsertTrustedPeer({ identity: peer, permissions: { transfer: true } });

  const legacyManifest = manifest(TASK_F);
  peers.database.exec(`
    CREATE TABLE transfer_jobs (
      task_id TEXT PRIMARY KEY, peer_device_id TEXT NOT NULL, direction TEXT NOT NULL, status TEXT NOT NULL,
      manifest_json TEXT NOT NULL, total_files INTEGER NOT NULL, total_bytes INTEGER NOT NULL,
      transferred_bytes INTEGER NOT NULL, completed_files INTEGER NOT NULL, diagnostic_code TEXT,
      error_message TEXT, retry_count INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL, started_at INTEGER, completed_at INTEGER, cancelled_at INTEGER
    );
    CREATE TABLE transfer_job_files (
      task_id TEXT NOT NULL REFERENCES transfer_jobs(task_id) ON DELETE CASCADE, relative_path TEXT NOT NULL,
      expected_bytes INTEGER NOT NULL, transferred_bytes INTEGER NOT NULL, sha256 TEXT NOT NULL,
      completed INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(task_id, relative_path)
    );
  `);
  peers.database.prepare(`
    INSERT INTO transfer_jobs (
      task_id, peer_device_id, direction, status, manifest_json, total_files, total_bytes,
      transferred_bytes, completed_files, diagnostic_code, error_message, retry_count,
      created_at, updated_at, started_at, completed_at, cancelled_at
    ) VALUES (?, ?, 'outgoing', 'queued', ?, ?, ?, 0, 1, NULL, NULL, 0, ?, ?, NULL, NULL, NULL)
  `).run(
    TASK_F, peer.deviceId, serializeTransferManifest(legacyManifest), legacyManifest.totalFiles,
    legacyManifest.totalBytes, 1759999999900, 1759999999900
  );
  const insertLegacyFile = peers.database.prepare(`
    INSERT INTO transfer_job_files (
      task_id, relative_path, expected_bytes, transferred_bytes, sha256, completed, updated_at
    ) VALUES (?, ?, ?, 0, ?, ?, ?)
  `);
  for (const file of legacyManifest.entries.filter((entry) => entry.kind === 'file')) {
    insertLegacyFile.run(TASK_F, file.path, file.size, file.sha256, file.size === 0 ? 1 : 0, 1759999999900);
  }

  jobs = new TransferJobStore(tempDir, peers);
  const migratedLegacy = jobs.get(TASK_F);
  assert.strictEqual(migratedLegacy.sourceMappingStatus, SOURCE_MAPPING_STATUS.MISSING);
  assert.strictEqual(migratedLegacy.sources, null);
  assert.strictEqual(migratedLegacy.recoverable, false);
  assert.strictEqual(
    jobs.database.prepare("SELECT COUNT(*) AS count FROM pragma_table_info('transfer_jobs') WHERE name = 'source_mapping_version'").get().count,
    1
  );

  assert.throws(
    () => jobs.queueOutgoing({ peerDeviceId: peer.deviceId, manifest: manifest(TASK_G) }),
    /sources must be an array/
  );
  assert.throws(
    () => jobs.queueOutgoing({
      peerDeviceId: peer.deviceId,
      manifest: manifest(TASK_G),
      sources: sourceMappings().slice(1)
    }),
    /match every manifest file exactly once/
  );
  const duplicatedSources = sourceMappings();
  duplicatedSources[2] = { ...duplicatedSources[1] };
  assert.throws(
    () => jobs.queueOutgoing({ peerDeviceId: peer.deviceId, manifest: manifest(TASK_G), sources: duplicatedSources }),
    /unique manifest file paths/
  );
  const mismatchedSources = sourceMappings();
  mismatchedSources[0] = { ...mismatchedSources[0], size: 1 };
  assert.throws(
    () => jobs.queueOutgoing({ peerDeviceId: peer.deviceId, manifest: manifest(TASK_G), sources: mismatchedSources }),
    /metadata does not match/
  );
  const relativeSources = sourceMappings();
  relativeSources[0] = { ...relativeSources[0], sourcePath: 'relative/empty.txt' };
  assert.throws(
    () => jobs.queueOutgoing({ peerDeviceId: peer.deviceId, manifest: manifest(TASK_G), sources: relativeSources }),
    /absolute path/
  );
  jobs.database.exec(`
    CREATE TEMP TRIGGER force_source_insert_rollback
    BEFORE INSERT ON transfer_job_sources
    WHEN NEW.task_id = '${TASK_G}'
    BEGIN
      SELECT RAISE(ABORT, 'forced source mapping insert failure');
    END;
  `);
  assert.throws(
    () => jobs.queueOutgoing({ peerDeviceId: peer.deviceId, manifest: manifest(TASK_G), sources: sourceMappings() }),
    /forced source mapping insert failure/
  );
  jobs.database.exec('DROP TRIGGER force_source_insert_rollback');
  assert.strictEqual(jobs.get(TASK_G), null);
  assert.strictEqual(jobs.database.prepare('SELECT COUNT(*) AS count FROM transfer_job_files WHERE task_id = ?').get(TASK_G).count, 0);

  const outgoing = jobs.queueOutgoing({ peerDeviceId: peer.deviceId, manifest: manifest(TASK_A), sources: sourceMappings(), now: 1760000000000 });
  assert.strictEqual(outgoing.direction, 'outgoing');
  assert.strictEqual(outgoing.status, JOB_STATUS.QUEUED);
  assert.strictEqual(outgoing.retryCount, 0);
  assert.strictEqual(outgoing.errorMessage, null);
  assert.strictEqual(outgoing.sourceMappingStatus, SOURCE_MAPPING_STATUS.AVAILABLE);
  assert.strictEqual(outgoing.recoverable, true);
  assert.deepStrictEqual(outgoing.sources, sourceMappings());
  assert.deepStrictEqual(outgoing.progress, { totalFiles: 3, completedFiles: 1, totalBytes: 12, transferredBytes: 0 });
  assert.strictEqual(jobs.getFiles(TASK_A)[2].completed, false);
  assert.throws(() => jobs.queueOutgoing({ peerDeviceId: peer.deviceId, manifest: manifest(TASK_A), sources: sourceMappings() }), /already exists/);
  assert.throws(() => jobs.queueOutgoing({ peerDeviceId: '0000000000000000', manifest: manifest(TASK_B), sources: sourceMappings() }), /not trusted/);
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

  assert.throws(
    () => jobs.receivePending({
      peerDeviceId: peer.deviceId,
      manifest: manifest(TASK_G),
      sources: sourceMappings(),
      now: 1760000000009
    }),
    /must not contain local source mappings/
  );
  const incoming = jobs.receivePending({ peerDeviceId: peer.deviceId, manifest: manifest(TASK_B), now: 1760000000010 });
  assert.strictEqual(incoming.status, JOB_STATUS.AWAITING_APPROVAL);
  assert.strictEqual(incoming.sourceMappingStatus, SOURCE_MAPPING_STATUS.NOT_APPLICABLE);
  assert.strictEqual(incoming.sources, null);
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

  const recoverable = jobs.queueOutgoing({ peerDeviceId: peer.deviceId, manifest: manifest(TASK_C), sources: sourceMappings(), now: 1760000000020 });
  jobs.start(recoverable.taskId, 1760000000021);
  jobs.recordFileProgress(TASK_C, 'photos/one.jpg', 4, 1760000000022);

  jobs.queueOutgoing({ peerDeviceId: peer.deviceId, manifest: manifest(TASK_D), sources: sourceMappings(), now: 1760000000023 });
  jobs.start(TASK_D, 1760000000024);
  jobs.recordFileProgress(TASK_D, 'photos/one.jpg', 2, 1760000000025);
  jobs.database.prepare('UPDATE transfer_jobs SET transferred_bytes = 1 WHERE task_id = ?').run(TASK_D);

  jobs.queueOutgoing({ peerDeviceId: peer.deviceId, manifest: manifest(TASK_E), sources: sourceMappings(), now: 1760000000026 });
  jobs.database.prepare(`
    UPDATE transfer_job_sources SET sha256 = 'corrupt' WHERE task_id = ? AND relative_path = 'photos/one.jpg'
  `).run(TASK_E);

  jobs.queueOutgoing({ peerDeviceId: peer.deviceId, manifest: manifest(TASK_H), sources: sourceMappings(), now: 1760000000027 });
  jobs.database.prepare(`
    DELETE FROM transfer_job_sources
    WHERE task_id = ? AND relative_path = 'photos/two.jpg'
  `).run(TASK_H);

  const incomingWithUnexpectedSources = jobs.receivePending({
    peerDeviceId: peer.deviceId,
    manifest: manifest(TASK_I),
    now: 1760000000028
  });
  assert.strictEqual(incomingWithUnexpectedSources.sourceMappingStatus, SOURCE_MAPPING_STATUS.NOT_APPLICABLE);
  jobs.database.prepare(`
    INSERT INTO transfer_job_sources (task_id, relative_path, source_path, expected_bytes, sha256)
    VALUES (?, ?, ?, ?, ?)
  `).run(TASK_I, 'photos/one.jpg', path.join(tempDir, 'unexpected', 'one.jpg'), 5, HASH_A);

  jobs.queueOutgoing({ peerDeviceId: peer.deviceId, manifest: manifest(TASK_J), sources: sourceMappings(), now: 1760000000029 });
  jobs.database.prepare(`
    UPDATE transfer_jobs SET manifest_json = ? WHERE task_id = ?
  `).run('{"manifest":"truncated"', TASK_J);


  jobs.close();
  jobs = null;

  reopened = new TransferJobStore(tempDir, peers);
  const afterRestart = reopened.get(TASK_C);
  assert.strictEqual(afterRestart.status, JOB_STATUS.PAUSED);
  assert.strictEqual(afterRestart.diagnosticCode, DIAGNOSTIC_CODE.APP_RESTARTED);
  assert.match(afterRestart.errorMessage, /application restarted/);
  assert.strictEqual(afterRestart.retryCount, 0);
  assert.strictEqual(afterRestart.progress.transferredBytes, 4);
  assert.strictEqual(afterRestart.sourceMappingStatus, SOURCE_MAPPING_STATUS.AVAILABLE);
  assert.strictEqual(afterRestart.recoverable, true);
  assert.deepStrictEqual(afterRestart.sources, sourceMappings());
  assert.strictEqual(reopened.listRecoverable().some((job) => job.taskId === TASK_C), true);

  const repairedAggregate = reopened.get(TASK_D);
  assert.strictEqual(repairedAggregate.status, JOB_STATUS.PAUSED);
  assert.strictEqual(repairedAggregate.progress.transferredBytes, 2);
  assert.strictEqual(reopened.get(TASK_E), null);
  const quarantined = reopened.database.prepare(`
    SELECT task_id, snapshot_json, reason FROM transfer_job_corruptions WHERE task_id = ?
  `).get(TASK_E);
  assert.strictEqual(quarantined.task_id, TASK_E);
  assert.match(quarantined.reason, /source metadata does not match/);
  const quarantinedSnapshot = JSON.parse(quarantined.snapshot_json);
  assert.strictEqual(quarantinedSnapshot.sources.length, 3);
  assert.strictEqual(quarantinedSnapshot.sources.some((source) => source.sha256 === 'corrupt'), true);
  assert.strictEqual(reopened.get(TASK_H), null);
  const missingSourceQuarantine = reopened.database.prepare(`
    SELECT snapshot_json, reason FROM transfer_job_corruptions WHERE task_id = ?
  `).get(TASK_H);
  assert.match(missingSourceQuarantine.reason, /source list does not match/);
  assert.strictEqual(JSON.parse(missingSourceQuarantine.snapshot_json).sources.length, 2);

  assert.strictEqual(reopened.get(TASK_I), null);
  const incomingSourceQuarantine = reopened.database.prepare(`
    SELECT snapshot_json, reason FROM transfer_job_corruptions WHERE task_id = ?
  `).get(TASK_I);
  assert.match(incomingSourceQuarantine.reason, /incoming transfer must not contain local source mappings/);
  assert.strictEqual(JSON.parse(incomingSourceQuarantine.snapshot_json).job.direction, 'incoming');

  assert.strictEqual(reopened.get(TASK_J), null);
  const invalidManifestQuarantine = reopened.database.prepare(`
    SELECT snapshot_json, reason FROM transfer_job_corruptions WHERE task_id = ?
  `).get(TASK_J);
  assert.match(invalidManifestQuarantine.reason, /Unexpected end|JSON|manifest/i);
  assert.strictEqual(JSON.parse(invalidManifestQuarantine.snapshot_json).job.manifest_json, '{"manifest":"truncated"');
  assert.strictEqual(reopened.get(TASK_B).retryCount, 1);

  const legacyOutgoing = reopened.get(TASK_F);
  assert.strictEqual(legacyOutgoing.sourceMappingStatus, SOURCE_MAPPING_STATUS.MISSING);
  assert.strictEqual(legacyOutgoing.sources, null);
  assert.strictEqual(legacyOutgoing.recoverable, false);
  assert.strictEqual(reopened.listRecoverable().some((job) => job.taskId === TASK_F), false);
  assert.throws(() => reopened.start(TASK_F, 1760000000028), /source file mappings are unavailable/);

  peers.revokeTrustedPeer(peer.deviceId, 1760000000030);
  assert.throws(() => reopened.resume(TASK_C), /not trusted/);
  assert.strictEqual(reopened.cancel(TASK_C, 1760000000031).status, JOB_STATUS.CANCELLED);
  assert.strictEqual(reopened.list().some((job) => job.taskId === TASK_A), false);
  assert.strictEqual(reopened.list({ includeTerminal: true }).length, 5);
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

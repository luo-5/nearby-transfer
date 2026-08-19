'use strict';

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const {
  assertValidTaskId,
  normalizeTransferManifest,
  parsePersistedTransferManifest,
  serializeTransferManifest
} = require('./transfer-manifest');
const { DATABASE_FILE } = require('./trusted-peer-store');

const JOB_STATUS = Object.freeze({
  QUEUED: 'queued',
  AWAITING_APPROVAL: 'awaiting-approval',
  TRANSFERRING: 'transferring',
  PAUSED: 'paused',
  FAILED: 'failed',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled'
});

const JOB_DIRECTION = Object.freeze({
  OUTGOING: 'outgoing',
  INCOMING: 'incoming'
});

const DIAGNOSTIC_CODE = Object.freeze({
  APP_RESTARTED: 'APP_RESTARTED',
  NETWORK_INTERRUPTED: 'NETWORK_INTERRUPTED',
  PEER_REVOKED: 'PEER_REVOKED',
  INTEGRITY_CHECK_FAILED: 'INTEGRITY_CHECK_FAILED',
  IO_ERROR: 'IO_ERROR',
  PROTOCOL_ERROR: 'PROTOCOL_ERROR',
  USER_CANCELLED: 'USER_CANCELLED'
});

const ALLOWED_DIAGNOSTIC_CODES = new Set(Object.values(DIAGNOSTIC_CODE));
const TRANSITIONS = Object.freeze({
  [JOB_STATUS.QUEUED]: new Set([JOB_STATUS.TRANSFERRING, JOB_STATUS.CANCELLED, JOB_STATUS.FAILED]),
  [JOB_STATUS.AWAITING_APPROVAL]: new Set([JOB_STATUS.QUEUED, JOB_STATUS.CANCELLED, JOB_STATUS.FAILED]),
  [JOB_STATUS.TRANSFERRING]: new Set([JOB_STATUS.PAUSED, JOB_STATUS.FAILED, JOB_STATUS.COMPLETED, JOB_STATUS.CANCELLED]),
  [JOB_STATUS.PAUSED]: new Set([JOB_STATUS.QUEUED, JOB_STATUS.CANCELLED, JOB_STATUS.FAILED]),
  [JOB_STATUS.FAILED]: new Set([JOB_STATUS.QUEUED, JOB_STATUS.CANCELLED]),
  [JOB_STATUS.COMPLETED]: new Set(),
  [JOB_STATUS.CANCELLED]: new Set()
});

class TransferJobStore {
  constructor(userDataDir, trustedPeerStore) {
    if (typeof userDataDir !== 'string' || userDataDir.trim().length === 0) {
      throw new TypeError('A user-data directory is required');
    }
    if (!trustedPeerStore || typeof trustedPeerStore.getTrustedPeer !== 'function') {
      throw new TypeError('A trusted peer store is required');
    }

    fs.mkdirSync(userDataDir, { recursive: true });
    this.trustedPeerStore = trustedPeerStore;
    this.databasePath = path.join(userDataDir, DATABASE_FILE);
    this.database = new DatabaseSync(this.databasePath, { enableForeignKeyConstraints: true });
    this._migrate();
    this._recoverInterruptedJobs();
  }

  queueOutgoing({ peerDeviceId, manifest, now = Date.now() }) {
    return this._createJob({
      peerDeviceId,
      manifest,
      direction: JOB_DIRECTION.OUTGOING,
      status: JOB_STATUS.QUEUED,
      now
    });
  }

  receivePending({ peerDeviceId, manifest, now = Date.now() }) {
    return this._createJob({
      peerDeviceId,
      manifest,
      direction: JOB_DIRECTION.INCOMING,
      status: JOB_STATUS.AWAITING_APPROVAL,
      now
    });
  }

  approveIncoming(taskId, now = Date.now()) {
    return this._transition(taskId, JOB_STATUS.QUEUED, { now, requireTrustedPeer: true });
  }

  start(taskId, now = Date.now()) {
    return this._transition(taskId, JOB_STATUS.TRANSFERRING, { now, requireTrustedPeer: true });
  }

  pause(taskId, now = Date.now()) {
    return this._transition(taskId, JOB_STATUS.PAUSED, { now, requireTrustedPeer: true });
  }

  resume(taskId, now = Date.now()) {
    return this._transition(taskId, JOB_STATUS.QUEUED, { now, requireTrustedPeer: true });
  }

  retry(taskId, now = Date.now()) {
    return this._transition(taskId, JOB_STATUS.QUEUED, { now, requireTrustedPeer: true, clearDiagnostic: true });
  }

  fail(taskId, diagnosticCode, now = Date.now()) {
    assertDiagnosticCode(diagnosticCode);
    return this._transition(taskId, JOB_STATUS.FAILED, { now, diagnosticCode, requireTrustedPeer: false });
  }

  cancel(taskId, now = Date.now()) {
    const job = this.get(taskId);
    if (!job || isTerminal(job.status)) {
      return false;
    }
    return this._transition(taskId, JOB_STATUS.CANCELLED, {
      now,
      diagnosticCode: DIAGNOSTIC_CODE.USER_CANCELLED,
      requireTrustedPeer: false
    });
  }

  recordFileProgress(taskId, relativePath, transferredBytes, now = Date.now()) {
    assertValidTaskId(taskId);
    assertTimestamp(now, 'Progress time');
    if (typeof relativePath !== 'string' || relativePath.length === 0) {
      throw new TypeError('A manifest file path is required');
    }
    if (!Number.isSafeInteger(transferredBytes) || transferredBytes < 0) {
      throw new TypeError('Transferred bytes must be a non-negative safe integer');
    }

    const job = this._requireJob(taskId);
    if (job.status !== JOB_STATUS.TRANSFERRING) {
      throw new Error('File progress can only be recorded while transferring');
    }
    this._requireActiveTransferPeer(job.peerDeviceId);

    const file = this.database.prepare(`
      SELECT expected_bytes, transferred_bytes FROM transfer_job_files
      WHERE task_id = ? AND relative_path = ?
    `).get(taskId, relativePath);
    if (!file) {
      throw new Error('File progress path is not declared by the transfer manifest');
    }
    if (transferredBytes < file.transferred_bytes) {
      throw new Error('File progress must be monotonic');
    }
    if (transferredBytes > file.expected_bytes) {
      throw new RangeError('File progress exceeds the manifest file size');
    }

    const complete = transferredBytes === file.expected_bytes ? 1 : 0;
    const update = this.database.prepare(`
      UPDATE transfer_job_files
      SET transferred_bytes = ?, completed = ?, updated_at = ?
      WHERE task_id = ? AND relative_path = ?
    `);
    update.run(transferredBytes, complete, now, taskId, relativePath);
    this._refreshProgress(taskId, now);
    return this._requireJob(taskId);
  }

  complete(taskId, now = Date.now()) {
    const job = this._requireJob(taskId);
    if (job.status !== JOB_STATUS.TRANSFERRING) {
      throw new Error('Only an active transfer can be completed');
    }
    this._requireActiveTransferPeer(job.peerDeviceId);
    const remaining = this.database.prepare(`
      SELECT COUNT(*) AS count FROM transfer_job_files
      WHERE task_id = ? AND transferred_bytes != expected_bytes
    `).get(taskId).count;
    if (remaining !== 0) {
      throw new Error('All manifest files must be fully transferred before completion');
    }
    return this._transition(taskId, JOB_STATUS.COMPLETED, { now, requireTrustedPeer: true });
  }

  get(taskId) {
    assertValidTaskId(taskId);
    const row = this.database.prepare('SELECT * FROM transfer_jobs WHERE task_id = ?').get(taskId);
    return row ? this._rowToJob(row) : null;
  }

  list({ includeTerminal = false } = {}) {
    if (typeof includeTerminal !== 'boolean') {
      throw new TypeError('includeTerminal must be a boolean');
    }
    const rows = this.database.prepare(`
      SELECT * FROM transfer_jobs
      ${includeTerminal ? '' : "WHERE status NOT IN ('completed', 'cancelled')"}
      ORDER BY created_at ASC, task_id ASC
    `).all();
    return rows.map((row) => this._rowToJob(row));
  }

  listRecoverable() {
    return this.list().filter((job) => !isTerminal(job.status));
  }

  getFiles(taskId) {
    assertValidTaskId(taskId);
    this._requireJob(taskId);
    return this.database.prepare(`
      SELECT relative_path, expected_bytes, transferred_bytes, sha256, completed
      FROM transfer_job_files WHERE task_id = ? ORDER BY relative_path ASC
    `).all(taskId).map((row) => ({
      path: row.relative_path,
      expectedBytes: row.expected_bytes,
      transferredBytes: row.transferred_bytes,
      sha256: row.sha256,
      completed: row.completed === 1
    }));
  }

  close() {
    this.database.close();
  }

  _createJob({ peerDeviceId, manifest, direction, status, now }) {
    assertTimestamp(now, 'Creation time');
    assertDirection(direction);
    assertStatus(status);
    const peer = this._requireActiveTransferPeer(peerDeviceId);
    const normalizedManifest = normalizeManifest(manifest);
    const existing = this.get(normalizedManifest.taskId);
    if (existing) {
      throw new Error('A transfer task with this ID already exists');
    }

    const manifestJson = serializeTransferManifest(normalizedManifest);
    const files = normalizedManifest.entries.filter((entry) => entry.kind === 'file');
    const insertJob = this.database.prepare(`
      INSERT INTO transfer_jobs (
        task_id, peer_device_id, direction, status, manifest_json, total_files, total_bytes,
        transferred_bytes, completed_files, diagnostic_code, created_at, updated_at,
        started_at, completed_at, cancelled_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, NULL, ?, ?, NULL, NULL, NULL)
    `);
    const insertFile = this.database.prepare(`
      INSERT INTO transfer_job_files (
        task_id, relative_path, expected_bytes, transferred_bytes, sha256, completed, updated_at
      ) VALUES (?, ?, ?, 0, ?, ?, ?)
    `);

    this.database.exec('BEGIN IMMEDIATE');
    try {
      insertJob.run(
        normalizedManifest.taskId,
        peer.identity.deviceId,
        direction,
        status,
        manifestJson,
        normalizedManifest.totalFiles,
        normalizedManifest.totalBytes,
        now,
        now
      );
      for (const file of files) {
        insertFile.run(
          normalizedManifest.taskId,
          file.path,
          file.size,
          file.sha256,
          file.size === 0 ? 1 : 0,
          now
        );
      }
      this._refreshProgress(normalizedManifest.taskId, now);
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
    return this._requireJob(normalizedManifest.taskId);
  }

  _transition(taskId, nextStatus, { now, diagnosticCode = null, requireTrustedPeer, clearDiagnostic = false }) {
    assertValidTaskId(taskId);
    assertTimestamp(now, 'Transition time');
    assertStatus(nextStatus);
    const job = this._requireJob(taskId);
    if (!TRANSITIONS[job.status].has(nextStatus)) {
      throw new Error(`Illegal transfer job transition: ${job.status} -> ${nextStatus}`);
    }
    if (requireTrustedPeer) {
      this._requireActiveTransferPeer(job.peerDeviceId);
    }
    if (diagnosticCode !== null) {
      assertDiagnosticCode(diagnosticCode);
    }

    const startedAt = nextStatus === JOB_STATUS.TRANSFERRING && job.startedAt === null ? now : job.startedAt;
    const completedAt = nextStatus === JOB_STATUS.COMPLETED ? now : job.completedAt;
    const cancelledAt = nextStatus === JOB_STATUS.CANCELLED ? now : job.cancelledAt;
    this.database.prepare(`
      UPDATE transfer_jobs
      SET status = ?, diagnostic_code = ?, updated_at = ?, started_at = ?, completed_at = ?, cancelled_at = ?
      WHERE task_id = ?
    `).run(
      nextStatus,
      clearDiagnostic ? null : diagnosticCode,
      now,
      startedAt,
      completedAt,
      cancelledAt,
      taskId
    );
    return this._requireJob(taskId);
  }

  _refreshProgress(taskId, now) {
    const progress = this.database.prepare(`
      SELECT COALESCE(SUM(transferred_bytes), 0) AS transferred_bytes,
             COALESCE(SUM(completed), 0) AS completed_files
      FROM transfer_job_files WHERE task_id = ?
    `).get(taskId);
    this.database.prepare(`
      UPDATE transfer_jobs SET transferred_bytes = ?, completed_files = ?, updated_at = ? WHERE task_id = ?
    `).run(progress.transferred_bytes, progress.completed_files, now, taskId);
  }

  _requireJob(taskId) {
    const job = this.get(taskId);
    if (!job) {
      throw new Error('Transfer task was not found');
    }
    return job;
  }

  _requireActiveTransferPeer(deviceId) {
    assertDeviceId(deviceId);
    const peer = this.trustedPeerStore.getTrustedPeer(deviceId);
    if (!peer || peer.permissions.transfer !== true) {
      throw new Error('Transfer task peer is not trusted for transfer');
    }
    return peer;
  }

  _recoverInterruptedJobs() {
    this.database.prepare(`
      UPDATE transfer_jobs
      SET status = ?, diagnostic_code = ?, updated_at = ?
      WHERE status = ?
    `).run(JOB_STATUS.PAUSED, DIAGNOSTIC_CODE.APP_RESTARTED, Date.now(), JOB_STATUS.TRANSFERRING);
  }

  _migrate() {
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS transfer_jobs (
        task_id TEXT PRIMARY KEY,
        peer_device_id TEXT NOT NULL,
        direction TEXT NOT NULL CHECK(direction IN ('outgoing', 'incoming')),
        status TEXT NOT NULL CHECK(status IN ('queued', 'awaiting-approval', 'transferring', 'paused', 'failed', 'completed', 'cancelled')),
        manifest_json TEXT NOT NULL,
        total_files INTEGER NOT NULL CHECK(total_files >= 0),
        total_bytes INTEGER NOT NULL CHECK(total_bytes >= 0),
        transferred_bytes INTEGER NOT NULL CHECK(transferred_bytes >= 0 AND transferred_bytes <= total_bytes),
        completed_files INTEGER NOT NULL CHECK(completed_files >= 0 AND completed_files <= total_files),
        diagnostic_code TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        started_at INTEGER,
        completed_at INTEGER,
        cancelled_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS transfer_job_files (
        task_id TEXT NOT NULL REFERENCES transfer_jobs(task_id) ON DELETE CASCADE,
        relative_path TEXT NOT NULL,
        expected_bytes INTEGER NOT NULL CHECK(expected_bytes >= 0),
        transferred_bytes INTEGER NOT NULL CHECK(transferred_bytes >= 0 AND transferred_bytes <= expected_bytes),
        sha256 TEXT NOT NULL,
        completed INTEGER NOT NULL CHECK(completed IN (0, 1)),
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(task_id, relative_path)
      );
      CREATE INDEX IF NOT EXISTS transfer_jobs_recovery
        ON transfer_jobs(status, updated_at, task_id);
      CREATE INDEX IF NOT EXISTS transfer_jobs_peer
        ON transfer_jobs(peer_device_id, status, created_at);
    `);
    this.database.prepare(`
      INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (3, ?)
    `).run(Date.now());
  }

  _rowToJob(row) {
    const manifest = parsePersistedTransferManifest(row.manifest_json);
    if (manifest.taskId !== row.task_id || manifest.totalFiles !== row.total_files || manifest.totalBytes !== row.total_bytes) {
      throw new Error('Persisted transfer job manifest does not match its indexed metadata');
    }
    return {
      taskId: row.task_id,
      peerDeviceId: row.peer_device_id,
      direction: row.direction,
      status: row.status,
      manifest,
      progress: {
        totalFiles: row.total_files,
        completedFiles: row.completed_files,
        totalBytes: row.total_bytes,
        transferredBytes: row.transferred_bytes
      },
      diagnosticCode: row.diagnostic_code,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      cancelledAt: row.cancelled_at
    };
  }
}

function normalizeManifest(manifest) {
  if (typeof manifest === 'string') {
    return parsePersistedTransferManifest(manifest);
  }
  return normalizeTransferManifest(manifest);
}

function assertStatus(status) {
  if (!Object.values(JOB_STATUS).includes(status)) {
    throw new TypeError('Transfer job status is invalid');
  }
}

function assertDirection(direction) {
  if (!Object.values(JOB_DIRECTION).includes(direction)) {
    throw new TypeError('Transfer job direction is invalid');
  }
}

function assertDiagnosticCode(code) {
  if (!ALLOWED_DIAGNOSTIC_CODES.has(code)) {
    throw new TypeError('Transfer job diagnostic code is invalid');
  }
}

function assertTimestamp(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
}

function assertDeviceId(deviceId) {
  if (typeof deviceId !== 'string' || !/^[a-f0-9]{16}$/.test(deviceId)) {
    throw new TypeError('Device ID must be 16 lowercase hexadecimal characters');
  }
}

function isTerminal(status) {
  return status === JOB_STATUS.COMPLETED || status === JOB_STATUS.CANCELLED;
}

module.exports = {
  DIAGNOSTIC_CODE,
  JOB_DIRECTION,
  JOB_STATUS,
  TransferJobStore
};

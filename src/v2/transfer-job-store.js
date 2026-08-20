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

const MAX_ERROR_MESSAGE_LENGTH = 1024;
const RESTART_ERROR_MESSAGE = 'Transfer was interrupted because the application restarted';
const SOURCE_MAPPING_STATUS = Object.freeze({
  AVAILABLE: 'available',
  MISSING: 'missing',
  NOT_APPLICABLE: 'not-applicable'
});
const SOURCE_MAPPING_VERSION = 1;
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
    try {
      this._assertDatabaseIntegrity();
      this._migrate();
      this._recoverInterruptedJobs();
      this._recoverPersistedJobs();
    } catch (error) {
      this.database.close();
      throw error;
    }
  }

  queueOutgoing({ peerDeviceId, manifest, sources, now = Date.now() }) {
    return this._createJob({
      peerDeviceId,
      manifest,
      sources,
      direction: JOB_DIRECTION.OUTGOING,
      status: JOB_STATUS.QUEUED,
      now
    });
  }

  receivePending({ peerDeviceId, manifest, sources, now = Date.now() }) {
    return this._createJob({
      peerDeviceId,
      manifest,
      sources,
      direction: JOB_DIRECTION.INCOMING,
      status: JOB_STATUS.AWAITING_APPROVAL,
      now
    });
  }

  approveIncoming(taskId, now = Date.now()) {
    return this._transition(taskId, JOB_STATUS.QUEUED, {
      now,
      requireTrustedPeer: true,
      allowedFrom: [JOB_STATUS.AWAITING_APPROVAL]
    });
  }

  start(taskId, now = Date.now()) {
    return this._transition(taskId, JOB_STATUS.TRANSFERRING, {
      now,
      requireTrustedPeer: true,
      allowedFrom: [JOB_STATUS.QUEUED]
    });
  }

  pause(taskId, now = Date.now()) {
    return this._transition(taskId, JOB_STATUS.PAUSED, {
      now,
      requireTrustedPeer: true,
      allowedFrom: [JOB_STATUS.TRANSFERRING]
    });
  }

  resume(taskId, now = Date.now()) {
    return this._transition(taskId, JOB_STATUS.QUEUED, {
      now,
      requireTrustedPeer: true,
      clearDiagnostic: true,
      allowedFrom: [JOB_STATUS.PAUSED]
    });
  }

  retry(taskId, now = Date.now()) {
    return this._transition(taskId, JOB_STATUS.QUEUED, {
      now,
      requireTrustedPeer: true,
      clearDiagnostic: true,
      incrementRetry: true,
      allowedFrom: [JOB_STATUS.FAILED]
    });
  }

  fail(taskId, diagnosticCode, now = Date.now(), errorMessage = null) {
    assertDiagnosticCode(diagnosticCode);
    return this._transition(taskId, JOB_STATUS.FAILED, {
      now,
      diagnosticCode,
      errorMessage,
      requireTrustedPeer: false
    });
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

    this._withImmediateTransaction(() => {
      const job = this._requireJob(taskId);
      if (job.status !== JOB_STATUS.TRANSFERRING) {
        throw new Error('File progress can only be recorded while transferring');
      }
      assertJobTimestamp(now, job.createdAt, 'Progress time');
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
      this.database.prepare(`
        UPDATE transfer_job_files
        SET transferred_bytes = ?, completed = ?, updated_at = ?
        WHERE task_id = ? AND relative_path = ?
      `).run(transferredBytes, complete, now, taskId, relativePath);
      this._refreshProgress(taskId, now);
    });
    return this._requireJob(taskId);
  }

  getOutgoingCheckpoint(taskId) {
    assertValidTaskId(taskId);
    const job = this._requireJob(taskId);
    if (job.direction !== JOB_DIRECTION.OUTGOING) {
      throw new Error('Outgoing checkpoints are only available for outgoing transfers');
    }
    return this._readOutgoingCheckpoint(taskId, job.manifest);
  }

  advanceOutgoingCheckpoint(taskId, checkpoint, now = Date.now()) {
    assertValidTaskId(taskId);
    assertTimestamp(now, 'Checkpoint time');

    let committed;
    this._withImmediateTransaction(() => {
      const job = this._requireJob(taskId);
      if (job.direction !== JOB_DIRECTION.OUTGOING) {
        throw new Error('Outgoing checkpoints can only advance outgoing transfers');
      }
      if (job.status !== JOB_STATUS.TRANSFERRING) {
        throw new Error('Outgoing checkpoints can only advance while transferring');
      }
      assertJobTimestamp(now, job.createdAt, 'Checkpoint time');
      this._requireActiveTransferPeer(job.peerDeviceId);
      const persistedAt = Math.max(now, job.updatedAt);

      const current = this._readOutgoingCheckpoint(taskId, job.manifest);
      const candidate = normalizeOutgoingCheckpoint(checkpoint, current.files);
      assertMonotonicOutgoingCheckpoint(current, candidate);

      const updateFile = this.database.prepare(`
        UPDATE transfer_job_files
        SET transferred_bytes = ?, completed = ?, updated_at = ?
        WHERE task_id = ? AND relative_path = ? AND expected_bytes = ?
      `);
      for (const file of candidate.files) {
        const result = updateFile.run(
          file.committedOffset,
          file.completed ? 1 : 0,
          persistedAt,
          taskId,
          file.path,
          file.size
        );
        if (result.changes !== 1) {
          throw new Error('Outgoing checkpoint file metadata changed during commit');
        }
      }

      const completedFiles = candidate.files.reduce(
        (count, file) => count + (file.completed ? 1 : 0),
        0
      );
      this.database.prepare(`
        UPDATE transfer_jobs
        SET transferred_bytes = ?, completed_files = ?, checkpoint_next_sequence = ?, updated_at = ?
        WHERE task_id = ?
      `).run(
        candidate.totalTransferred,
        completedFiles,
        candidate.nextSequence,
        persistedAt,
        taskId
      );
      committed = candidate;
    });
    return committed;
  }

  complete(taskId, now = Date.now()) {
    const job = this._requireJob(taskId);
    if (job.status !== JOB_STATUS.TRANSFERRING) {
      throw new Error('Only an active transfer can be completed');
    }
    this._requireActiveTransferPeer(job.peerDeviceId);
    const remaining = this.database.prepare(`
      SELECT COUNT(*) AS count FROM transfer_job_files
      WHERE task_id = ? AND completed != 1
    `).get(taskId).count;
    if (remaining !== 0) {
      throw new Error('All manifest files must be fully transferred before completion');
    }
    return this._transition(taskId, JOB_STATUS.COMPLETED, {
      now,
      requireTrustedPeer: true,
      allowedFrom: [JOB_STATUS.TRANSFERRING]
    });
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
    return this.list().filter((job) => job.recoverable);
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

  _readOutgoingCheckpoint(taskId, manifest) {
    const row = this.database.prepare(`
      SELECT checkpoint_next_sequence, transferred_bytes, completed_files
      FROM transfer_jobs WHERE task_id = ?
    `).get(taskId);
    if (!row) {
      throw new Error('Transfer task was not found');
    }
    assertProgressValue(row.checkpoint_next_sequence, 'Outgoing checkpoint sequence');
    const expectedFiles = manifest.entries.filter((entry) => entry.kind === 'file');
    const persistedFiles = this.database.prepare(`
      SELECT relative_path, expected_bytes, transferred_bytes, sha256, completed
      FROM transfer_job_files WHERE task_id = ?
    `).all(taskId);
    if (persistedFiles.length !== expectedFiles.length) {
      throw new Error('Persisted outgoing checkpoint file list does not match its manifest');
    }
    const persistedByPath = new Map(persistedFiles.map((file) => [file.relative_path, file]));
    const files = expectedFiles.map((expected) => {
      const file = persistedByPath.get(expected.path);
      if (!file) {
        throw new Error('Persisted outgoing checkpoint file list does not match its manifest');
      }
      if (file.relative_path !== expected.path || file.expected_bytes !== expected.size ||
          file.sha256 !== expected.sha256) {
        throw new Error('Persisted outgoing checkpoint file metadata does not match its manifest');
      }
      assertProgressValue(file.transferred_bytes, 'Persisted outgoing checkpoint offset');
      if (file.transferred_bytes > file.expected_bytes || ![0, 1].includes(file.completed)) {
        throw new RangeError('Persisted outgoing checkpoint file progress is invalid');
      }
      const completed = file.completed === 1;
      if ((completed && file.transferred_bytes !== file.expected_bytes) ||
          (!completed && file.expected_bytes !== 0 && file.transferred_bytes === file.expected_bytes)) {
        throw new Error('Persisted outgoing checkpoint completion marker is inconsistent');
      }
      return {
        path: file.relative_path,
        size: file.expected_bytes,
        committedOffset: file.transferred_bytes,
        completed
      };
    });
    const totalTransferred = files.reduce(
      (total, file) => checkedProgressAdd(total, file.committedOffset, 'Outgoing checkpoint total'),
      0
    );
    const completedFiles = files.reduce((total, file) => total + (file.completed ? 1 : 0), 0);
    if (row.transferred_bytes !== totalTransferred || row.completed_files !== completedFiles) {
      throw new Error('Persisted outgoing checkpoint aggregate does not match its file progress');
    }
    validateContiguousOutgoingCheckpoint(files);
    return {
      files,
      totalTransferred,
      nextSequence: row.checkpoint_next_sequence
    };
  }

  close() {
    this.database.close();
  }

  _createJob({ peerDeviceId, manifest, sources, direction, status, now }) {
    assertTimestamp(now, 'Creation time');
    assertDirection(direction);
    assertStatus(status);
    const peer = this._requireActiveTransferPeer(peerDeviceId);
    const normalizedManifest = normalizeManifest(manifest);
    const normalizedSources = normalizeSourcesForJob(direction, sources, normalizedManifest);
    const existing = this.get(normalizedManifest.taskId);
    if (existing) {
      throw new Error('A transfer task with this ID already exists');
    }

    const manifestJson = serializeTransferManifest(normalizedManifest);
    const files = normalizedManifest.entries.filter((entry) => entry.kind === 'file');
    const sourceMappingVersion = direction === JOB_DIRECTION.OUTGOING ? SOURCE_MAPPING_VERSION : 0;
    const insertJob = this.database.prepare(`
      INSERT INTO transfer_jobs (
        task_id, peer_device_id, direction, status, manifest_json, total_files, total_bytes,
        transferred_bytes, completed_files, diagnostic_code, error_message, retry_count,
        source_mapping_version, created_at, updated_at, started_at, completed_at, cancelled_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, NULL, NULL, 0, ?, ?, ?, NULL, NULL, NULL)
    `);
    const insertFile = this.database.prepare(`
      INSERT INTO transfer_job_files (
        task_id, relative_path, expected_bytes, transferred_bytes, sha256, completed, updated_at
      ) VALUES (?, ?, ?, 0, ?, ?, ?)
    `);
    const insertSource = this.database.prepare(`
      INSERT INTO transfer_job_sources (task_id, relative_path, source_path, expected_bytes, sha256)
      VALUES (?, ?, ?, ?, ?)
    `);

    this._withImmediateTransaction(() => {
      insertJob.run(
        normalizedManifest.taskId,
        peer.identity.deviceId,
        direction,
        status,
        manifestJson,
        normalizedManifest.totalFiles,
        normalizedManifest.totalBytes,
        sourceMappingVersion,
        now,
        now
      );
      for (const file of files) {
        insertFile.run(
          normalizedManifest.taskId,
          file.path,
          file.size,
          file.sha256,
          0,
          now
        );
      }
      for (const source of normalizedSources) {
        insertSource.run(
          normalizedManifest.taskId,
          source.path,
          source.sourcePath,
          source.size,
          source.sha256
        );
      }
      this._refreshProgress(normalizedManifest.taskId, now);
    });
    return this._requireJob(normalizedManifest.taskId);
  }

  _transition(taskId, nextStatus, {
    now,
    diagnosticCode = null,
    errorMessage = null,
    requireTrustedPeer,
    clearDiagnostic = false,
    incrementRetry = false,
    allowedFrom = null
  }) {
    assertValidTaskId(taskId);
    assertTimestamp(now, 'Transition time');
    assertStatus(nextStatus);
    if (diagnosticCode !== null) {
      assertDiagnosticCode(diagnosticCode);
    }
    const normalizedError = normalizeErrorMessage(errorMessage);

    this._withImmediateTransaction(() => {
      const job = this._requireJob(taskId);
      if ((nextStatus === JOB_STATUS.QUEUED || nextStatus === JOB_STATUS.TRANSFERRING) &&
          job.direction === JOB_DIRECTION.OUTGOING &&
          job.sourceMappingStatus !== SOURCE_MAPPING_STATUS.AVAILABLE) {
        throw new Error('Outgoing transfer cannot resume because its source file mappings are unavailable');
      }
      const legalTargets = TRANSITIONS[job.status];
      if (!legalTargets || !legalTargets.has(nextStatus) || (allowedFrom && !allowedFrom.includes(job.status))) {
        throw new Error(`Illegal transfer job transition: ${job.status} -> ${nextStatus}`);
      }
      assertJobTimestamp(now, job.createdAt, 'Transition time');
      if (requireTrustedPeer) {
        this._requireActiveTransferPeer(job.peerDeviceId);
      }
      if (incrementRetry && job.retryCount >= Number.MAX_SAFE_INTEGER) {
        throw new RangeError('Transfer job retry count exceeds the safe integer range');
      }

      const startedAt = nextStatus === JOB_STATUS.TRANSFERRING && job.startedAt === null ? now : job.startedAt;
      const completedAt = nextStatus === JOB_STATUS.COMPLETED ? now : job.completedAt;
      const cancelledAt = nextStatus === JOB_STATUS.CANCELLED ? now : job.cancelledAt;
      const nextDiagnostic = clearDiagnostic ? null : diagnosticCode;
      const nextError = clearDiagnostic ? null : normalizedError;
      this.database.prepare(`
        UPDATE transfer_jobs
        SET status = ?, diagnostic_code = ?, error_message = ?, retry_count = retry_count + ?,
            updated_at = ?, started_at = ?, completed_at = ?, cancelled_at = ?
        WHERE task_id = ?
      `).run(
        nextStatus,
        nextDiagnostic,
        nextError,
        incrementRetry ? 1 : 0,
        now,
        startedAt,
        completedAt,
        cancelledAt,
        taskId
      );
    });
    return this._requireJob(taskId);
  }

  _refreshProgress(taskId, now) {
    const progress = this.database.prepare(`
      SELECT COALESCE(SUM(transferred_bytes), 0) AS transferred_bytes,
             COALESCE(SUM(completed), 0) AS completed_files
      FROM transfer_job_files WHERE task_id = ?
    `).get(taskId);
    if (!Number.isSafeInteger(progress.transferred_bytes) || !Number.isSafeInteger(progress.completed_files)) {
      throw new RangeError('Transfer progress exceeds the safe integer range');
    }
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

  _withImmediateTransaction(callback) {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const result = callback();
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  _assertDatabaseIntegrity() {
    let rows;
    try {
      rows = this.database.prepare('PRAGMA quick_check').all();
    } catch (error) {
      throw new Error(`Transfer database is corrupt; the original file was preserved at ${this.databasePath}`, { cause: error });
    }
    if (rows.length !== 1 || rows[0].quick_check !== 'ok') {
      throw new Error(`Transfer database integrity check failed; the original file was preserved at ${this.databasePath}`);
    }
  }

  _recoverInterruptedJobs() {
    const now = Date.now();
    this._withImmediateTransaction(() => {
      this.database.prepare(`
        UPDATE transfer_jobs
        SET status = ?, diagnostic_code = ?, error_message = ?, updated_at = MAX(updated_at, ?)
        WHERE LOWER(status) IN ('transferring', 'running')
      `).run(JOB_STATUS.PAUSED, DIAGNOSTIC_CODE.APP_RESTARTED, RESTART_ERROR_MESSAGE, now);
    });
  }

  _recoverPersistedJobs() {
    const quarantinedAt = Date.now();
    this._withImmediateTransaction(() => {
      const rows = this.database.prepare('SELECT * FROM transfer_jobs ORDER BY task_id ASC').all();
      for (const row of rows) {
        const files = this.database.prepare(`
          SELECT * FROM transfer_job_files WHERE task_id = ? ORDER BY relative_path ASC
        `).all(row.task_id);
        const sources = this.database.prepare(`
          SELECT * FROM transfer_job_sources WHERE task_id = ? ORDER BY relative_path ASC
        `).all(row.task_id);
        try {
          const job = this._rowToJob(row, sources);
          const repaired = validatePersistedFiles(job, files);
          if (job.progress.transferredBytes !== repaired.transferredBytes ||
              job.progress.completedFiles !== repaired.completedFiles) {
            const updatedAt = Math.max(job.updatedAt, repaired.updatedAt);
            this.database.prepare(`
              UPDATE transfer_jobs
              SET transferred_bytes = ?, completed_files = ?, updated_at = ?
              WHERE task_id = ?
            `).run(repaired.transferredBytes, repaired.completedFiles, updatedAt, job.taskId);
          }
        } catch (error) {
          const reason = String(error && error.message ? error.message : error).slice(0, 2048);
          const snapshot = JSON.stringify({ job: row, files, sources });
          this.database.prepare(`
            INSERT INTO transfer_job_corruptions(task_id, snapshot_json, reason, quarantined_at)
            VALUES (?, ?, ?, ?)
          `).run(typeof row.task_id === 'string' ? row.task_id : null, snapshot, reason, quarantinedAt);
          this.database.prepare('DELETE FROM transfer_jobs WHERE task_id = ?').run(row.task_id);
        }
      }
    });
  }

  _migrate() {
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA foreign_keys = ON;
    `);
    this._withImmediateTransaction(() => {
      this.database.exec(`
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
          checkpoint_next_sequence INTEGER NOT NULL DEFAULT 0 CHECK(checkpoint_next_sequence >= 0),
          diagnostic_code TEXT,
          error_message TEXT,
          retry_count INTEGER NOT NULL DEFAULT 0 CHECK(retry_count >= 0),
          source_mapping_version INTEGER NOT NULL DEFAULT 0 CHECK(source_mapping_version IN (0, 1)),
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
        CREATE TABLE IF NOT EXISTS transfer_job_sources (
          task_id TEXT NOT NULL REFERENCES transfer_jobs(task_id) ON DELETE CASCADE,
          relative_path TEXT NOT NULL,
          source_path TEXT NOT NULL,
          expected_bytes INTEGER NOT NULL CHECK(expected_bytes >= 0),
          sha256 TEXT NOT NULL,
          PRIMARY KEY(task_id, relative_path)
        );
        CREATE TABLE IF NOT EXISTS transfer_job_corruptions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          task_id TEXT,
          snapshot_json TEXT NOT NULL,
          reason TEXT NOT NULL,
          quarantined_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS transfer_jobs_recovery
          ON transfer_jobs(status, updated_at, task_id);
        CREATE INDEX IF NOT EXISTS transfer_jobs_peer
          ON transfer_jobs(peer_device_id, status, created_at);
      `);

      const columns = new Set(this.database.prepare('PRAGMA table_info(transfer_jobs)').all().map((column) => column.name));
      if (!columns.has('error_message')) {
        this.database.exec('ALTER TABLE transfer_jobs ADD COLUMN error_message TEXT');
      }
      if (!columns.has('retry_count')) {
        this.database.exec('ALTER TABLE transfer_jobs ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0 CHECK(retry_count >= 0)');
      }
      if (!columns.has('source_mapping_version')) {
        this.database.exec('ALTER TABLE transfer_jobs ADD COLUMN source_mapping_version INTEGER NOT NULL DEFAULT 0 CHECK(source_mapping_version IN (0, 1))');
      }
      if (!columns.has('checkpoint_next_sequence')) {
        this.database.exec('ALTER TABLE transfer_jobs ADD COLUMN checkpoint_next_sequence INTEGER NOT NULL DEFAULT 0 CHECK(checkpoint_next_sequence >= 0)');
        // Older builds marked empty files complete at queue time. Protocol v2
        // requires the receiver's durable acknowledgement even for empty files.
        this.database.exec(`
          UPDATE transfer_job_files
          SET completed = 0
          WHERE expected_bytes = 0
            AND task_id IN (
              SELECT task_id FROM transfer_jobs
              WHERE direction = 'outgoing' AND status != 'completed'
            )
        `);
        this.database.exec(`
          UPDATE transfer_jobs
          SET completed_files = (
            SELECT COUNT(*) FROM transfer_job_files
            WHERE transfer_job_files.task_id = transfer_jobs.task_id AND completed = 1
          )
          WHERE direction = 'outgoing' AND status != 'completed'
        `);
      }
      this.database.prepare(`
        INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (3, ?)
      `).run(Date.now());
      this.database.prepare(`
        INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (4, ?)
      `).run(Date.now());
      this.database.prepare(`
        INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (5, ?)
      `).run(Date.now());
      this.database.prepare(`
        INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (6, ?)
      `).run(Date.now());
    });
  }

  _rowToJob(row, persistedSources = null) {
    assertValidTaskId(row.task_id);
    assertDeviceId(row.peer_device_id);
    assertDirection(row.direction);
    assertStatus(row.status);
    assertProgressValue(row.total_files, 'Total file count');
    assertProgressValue(row.completed_files, 'Completed file count');
    assertProgressValue(row.total_bytes, 'Total byte count');
    assertProgressValue(row.transferred_bytes, 'Transferred byte count');
    if (row.completed_files > row.total_files || row.transferred_bytes > row.total_bytes) {
      throw new RangeError('Persisted transfer progress exceeds its declared total');
    }
    assertProgressValue(row.checkpoint_next_sequence, 'Outgoing checkpoint sequence');
    if (!Number.isSafeInteger(row.retry_count) || row.retry_count < 0) {
      throw new RangeError('Persisted transfer retry count is invalid');
    }
    if (row.diagnostic_code !== null) {
      assertDiagnosticCode(row.diagnostic_code);
    }
    const errorMessage = normalizeErrorMessage(row.error_message);
    assertTimestamp(row.created_at, 'Creation time');
    assertTimestamp(row.updated_at, 'Update time');
    if (row.updated_at < row.created_at) {
      throw new RangeError('Persisted transfer update time precedes creation time');
    }
    assertOptionalTimestamp(row.started_at, 'Start time', row.created_at, row.updated_at);
    assertOptionalTimestamp(row.completed_at, 'Completion time', row.created_at, row.updated_at);
    assertOptionalTimestamp(row.cancelled_at, 'Cancellation time', row.created_at, row.updated_at);
    if ((row.status === JOB_STATUS.COMPLETED) !== (row.completed_at !== null)) {
      throw new Error('Persisted completed transfer has inconsistent completion metadata');
    }
    if ((row.status === JOB_STATUS.CANCELLED) !== (row.cancelled_at !== null)) {
      throw new Error('Persisted cancelled transfer has inconsistent cancellation metadata');
    }

    const manifest = parsePersistedTransferManifest(row.manifest_json);
    if (manifest.taskId !== row.task_id || manifest.totalFiles !== row.total_files || manifest.totalBytes !== row.total_bytes) {
      throw new Error('Persisted transfer job manifest does not match its indexed metadata');
    }
    if (!Number.isSafeInteger(row.source_mapping_version) ||
        (row.source_mapping_version !== 0 && row.source_mapping_version !== SOURCE_MAPPING_VERSION)) {
      throw new Error('Persisted transfer source mapping version is invalid');
    }
    const sourceRows = persistedSources || this.database.prepare(`
      SELECT * FROM transfer_job_sources WHERE task_id = ? ORDER BY relative_path ASC
    `).all(row.task_id);
    const sourceMapping = validatePersistedSources({
      direction: row.direction,
      manifest,
      sourceMappingVersion: row.source_mapping_version
    }, sourceRows);
    const recoverable = !isTerminal(row.status) &&
      (row.direction !== JOB_DIRECTION.OUTGOING || sourceMapping.status === SOURCE_MAPPING_STATUS.AVAILABLE);
    return {
      taskId: row.task_id,
      peerDeviceId: row.peer_device_id,
      direction: row.direction,
      status: row.status,
      manifest,
      sources: sourceMapping.sources,
      sourceMappingStatus: sourceMapping.status,
      recoverable,
      progress: {
        totalFiles: row.total_files,
        completedFiles: row.completed_files,
        totalBytes: row.total_bytes,
        transferredBytes: row.transferred_bytes
      },
      diagnosticCode: row.diagnostic_code,
      errorMessage,
      retryCount: row.retry_count,
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

function normalizeSourcesForJob(direction, sources, manifest) {
  const expectedFiles = manifest.entries.filter((entry) => entry.kind === 'file');
  if (direction === JOB_DIRECTION.INCOMING) {
    if (sources !== undefined && sources !== null) {
      throw new TypeError('Incoming transfer jobs must not contain local source mappings');
    }
    return [];
  }
  if (!Array.isArray(sources)) {
    throw new TypeError('Outgoing transfer sources must be an array');
  }
  if (sources.length !== expectedFiles.length) {
    throw new Error('Outgoing transfer sources must match every manifest file exactly once');
  }

  const expectedByPath = new Map(expectedFiles.map((file) => [file.path, file]));
  const normalizedByPath = new Map();
  for (const source of sources) {
    if (!source || typeof source !== 'object' || Array.isArray(source) || Object.getPrototypeOf(source) !== Object.prototype) {
      throw new TypeError('Transfer source mapping must be a plain object');
    }
    const keys = Object.keys(source).sort();
    if (keys.length !== 4 || keys.join(',') !== 'path,sha256,size,sourcePath') {
      throw new TypeError('Transfer source mapping contains unsupported fields');
    }
    if (typeof source.path !== 'string' || normalizedByPath.has(source.path)) {
      throw new TypeError('Transfer source paths must be unique manifest file paths');
    }
    const expected = expectedByPath.get(source.path);
    if (!expected) {
      throw new Error('Transfer source path is not declared as a manifest file');
    }
    assertSourcePath(source.sourcePath);
    assertProgressValue(source.size, 'Transfer source size');
    if (typeof source.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(source.sha256)) {
      throw new TypeError('Transfer source SHA-256 must be 64 lowercase hexadecimal characters');
    }
    if (source.size !== expected.size || source.sha256 !== expected.sha256) {
      throw new Error('Transfer source metadata does not match its manifest file');
    }
    normalizedByPath.set(source.path, {
      path: source.path,
      sourcePath: source.sourcePath,
      size: source.size,
      sha256: source.sha256
    });
  }
  return expectedFiles.map((file) => normalizedByPath.get(file.path));
}

function validatePersistedSources(job, rows) {
  const expectedFiles = job.manifest.entries.filter((entry) => entry.kind === 'file');
  if (job.direction === JOB_DIRECTION.INCOMING) {
    if (job.sourceMappingVersion !== 0 || rows.length !== 0) {
      throw new Error('Persisted incoming transfer must not contain local source mappings');
    }
    return { status: SOURCE_MAPPING_STATUS.NOT_APPLICABLE, sources: null };
  }

  if (job.sourceMappingVersion === 0) {
    if (rows.length !== 0) {
      throw new Error('Legacy outgoing transfer has inconsistent source mapping metadata');
    }
    return expectedFiles.length === 0
      ? { status: SOURCE_MAPPING_STATUS.AVAILABLE, sources: [] }
      : { status: SOURCE_MAPPING_STATUS.MISSING, sources: null };
  }
  if (rows.length !== expectedFiles.length) {
    throw new Error('Persisted transfer source list does not match its manifest');
  }

  const rowsByPath = new Map();
  for (const row of rows) {
    if (typeof row.relative_path !== 'string' || rowsByPath.has(row.relative_path)) {
      throw new Error('Persisted transfer source paths are invalid or duplicated');
    }
    rowsByPath.set(row.relative_path, row);
  }
  const sources = expectedFiles.map((expected) => {
    const row = rowsByPath.get(expected.path);
    if (!row || row.expected_bytes !== expected.size || row.sha256 !== expected.sha256) {
      throw new Error('Persisted transfer source metadata does not match its manifest');
    }
    assertSourcePath(row.source_path);
    return {
      path: expected.path,
      sourcePath: row.source_path,
      size: row.expected_bytes,
      sha256: row.sha256
    };
  });
  return { status: SOURCE_MAPPING_STATUS.AVAILABLE, sources };
}

function assertSourcePath(sourcePath) {
  if (typeof sourcePath !== 'string' || sourcePath.length === 0 || sourcePath.includes('\0')) {
    throw new TypeError('Transfer source path must be a non-empty absolute path');
  }
  if (Buffer.byteLength(sourcePath, 'utf8') > 32_768 || !path.isAbsolute(sourcePath)) {
    throw new TypeError('Transfer source path must be a bounded absolute path');
  }
}

function validatePersistedFiles(job, rows) {
  const expectedFiles = job.manifest.entries.filter((entry) => entry.kind === 'file');
  if (rows.length !== expectedFiles.length) {
    throw new Error('Persisted transfer file list does not match its manifest');
  }
  const expectedByPath = new Map(expectedFiles.map((file) => [file.path, file]));
  let transferredBytes = 0;
  let completedFiles = 0;
  let updatedAt = job.updatedAt;
  for (const row of rows) {
    const expected = expectedByPath.get(row.relative_path);
    if (!expected || row.expected_bytes !== expected.size || row.sha256 !== expected.sha256) {
      throw new Error('Persisted transfer file metadata does not match its manifest');
    }
    assertProgressValue(row.transferred_bytes, 'Persisted file byte count');
    if (row.transferred_bytes > row.expected_bytes || ![0, 1].includes(row.completed)) {
      throw new RangeError('Persisted transfer file progress is invalid');
    }
    const completed = row.completed === 1;
    if ((completed && row.transferred_bytes !== row.expected_bytes) ||
        (!completed && row.expected_bytes !== 0 && row.transferred_bytes === row.expected_bytes)) {
      throw new Error('Persisted transfer file completion marker is inconsistent');
    }
    assertTimestamp(row.updated_at, 'Persisted file update time');
    if (row.updated_at < job.createdAt) {
      throw new RangeError('Persisted file update time precedes job creation time');
    }
    transferredBytes += row.transferred_bytes;
    completedFiles += row.completed;
    updatedAt = Math.max(updatedAt, row.updated_at);
    if (!Number.isSafeInteger(transferredBytes) || !Number.isSafeInteger(completedFiles)) {
      throw new RangeError('Persisted transfer progress exceeds the safe integer range');
    }
  }
  return { transferredBytes, completedFiles, updatedAt };
}

function normalizeOutgoingCheckpoint(checkpoint, expectedFiles) {
  assertPlainCheckpointObject(checkpoint, 'Outgoing checkpoint');
  assertExactCheckpointKeys(
    checkpoint,
    ['files', 'totalTransferred', 'nextSequence'],
    'Outgoing checkpoint'
  );
  if (!Array.isArray(checkpoint.files) || checkpoint.files.length !== expectedFiles.length) {
    throw new Error('Outgoing checkpoint file list does not match the transfer manifest');
  }
  assertProgressValue(checkpoint.totalTransferred, 'Outgoing checkpoint total transferred');
  assertProgressValue(checkpoint.nextSequence, 'Outgoing checkpoint sequence');

  let totalTransferred = 0;
  const files = checkpoint.files.map((file, index) => {
    assertPlainCheckpointObject(file, 'Outgoing checkpoint file');
    assertExactCheckpointKeys(
      file,
      ['path', 'size', 'committedOffset', 'completed'],
      'Outgoing checkpoint file'
    );
    const expected = expectedFiles[index];
    if (file.path !== expected.path || file.size !== expected.size) {
      throw new Error('Outgoing checkpoint file list does not match the transfer manifest');
    }
    assertProgressValue(file.committedOffset, 'Outgoing checkpoint committed offset');
    if (file.committedOffset > file.size) {
      throw new RangeError('Outgoing checkpoint committed offset exceeds the manifest file size');
    }
    if (typeof file.completed !== 'boolean') {
      throw new TypeError('Outgoing checkpoint completed marker must be a boolean');
    }
    if ((file.completed && file.committedOffset !== file.size) ||
        (!file.completed && file.size !== 0 && file.committedOffset === file.size)) {
      throw new Error('Outgoing checkpoint file completion marker is inconsistent');
    }
    totalTransferred = checkedProgressAdd(
      totalTransferred,
      file.committedOffset,
      'Outgoing checkpoint total'
    );
    return {
      path: file.path,
      size: file.size,
      committedOffset: file.committedOffset,
      completed: file.completed
    };
  });
  validateContiguousOutgoingCheckpoint(files);
  if (checkpoint.totalTransferred !== totalTransferred) {
    throw new Error('Outgoing checkpoint total transferred must equal committed file offsets');
  }
  return { files, totalTransferred, nextSequence: checkpoint.nextSequence };
}

function assertMonotonicOutgoingCheckpoint(previous, candidate) {
  if (candidate.totalTransferred < previous.totalTransferred) {
    throw new Error('Outgoing checkpoint total transferred must not move backwards');
  }
  if (candidate.nextSequence < previous.nextSequence) {
    throw new Error('Outgoing checkpoint sequence must not move backwards');
  }
  for (let index = 0; index < previous.files.length; index += 1) {
    const before = previous.files[index];
    const after = candidate.files[index];
    if (after.committedOffset < before.committedOffset) {
      throw new Error('Outgoing checkpoint file offsets must not move backwards');
    }
    if (before.completed && !after.completed) {
      throw new Error('Outgoing checkpoint completion markers must not move backwards');
    }
  }
}

function validateContiguousOutgoingCheckpoint(files) {
  let foundIncomplete = false;
  for (const file of files) {
    if (!foundIncomplete) {
      if (!file.completed) foundIncomplete = true;
    } else if (file.completed || file.committedOffset !== 0) {
      throw new Error('Outgoing checkpoint progress must be contiguous in manifest order');
    }
  }
}

function checkedProgressAdd(left, right, label) {
  if (left > Number.MAX_SAFE_INTEGER - right) {
    throw new RangeError(`${label} exceeds the safe integer range`);
  }
  return left + right;
}

function assertPlainCheckpointObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new TypeError(`${label} must be a plain object`);
  }
}

function assertExactCheckpointKeys(value, expected, label) {
  const expectedKeys = new Set(expected);
  for (const key of expected) {
    if (!Object.hasOwn(value, key)) {
      throw new TypeError(`${label} is missing ${key}`);
    }
  }
  for (const key of Object.keys(value)) {
    if (!expectedKeys.has(key)) {
      throw new TypeError(`${label} contains an unsupported field: ${key}`);
    }
  }
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

function normalizeErrorMessage(value) {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== 'string') {
    throw new TypeError('Transfer job error message must be a string');
  }
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > MAX_ERROR_MESSAGE_LENGTH) {
    throw new TypeError(`Transfer job error message must contain 1-${MAX_ERROR_MESSAGE_LENGTH} characters`);
  }
  return normalized;
}

function assertTimestamp(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
}

function assertJobTimestamp(value, createdAt, label) {
  assertTimestamp(value, label);
  if (value < createdAt) {
    throw new RangeError(`${label} cannot precede the transfer creation time`);
  }
}

function assertOptionalTimestamp(value, label, minimum, maximum) {
  if (value === null) {
    return;
  }
  assertTimestamp(value, label);
  if (value < minimum || value > maximum) {
    throw new RangeError(`${label} is outside the transfer job lifetime`);
  }
}

function assertProgressValue(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
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
  SOURCE_MAPPING_STATUS,
  JOB_DIRECTION,
  JOB_STATUS,
  TransferJobStore
};

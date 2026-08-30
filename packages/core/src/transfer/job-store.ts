/**
 * Transfer job store with JSON file persistence. Replaces the SQLite-backed
 * TransferJobStore (src/v2/transfer-job-store.js, 1155 lines) with a
 * zero-native-dependency JSON file, keeping the same public API and state
 * machine.
 *
 * Jobs track the lifecycle of each transfer: queued → transferring →
 * completed/failed/cancelled, with pause/resume and checkpoint persistence
 * for resumable transfers.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import {
  assertValidTaskId,
  normalizeTransferManifest,
  parsePersistedTransferManifest,
  serializeTransferManifest,
  type TransferManifest,
  type ManifestEntry,
} from './manifest.js';

export const JOB_STATUS = Object.freeze({
  QUEUED: 'queued',
  AWAITING_APPROVAL: 'awaiting-approval',
  TRANSFERRING: 'transferring',
  PAUSED: 'paused',
  FAILED: 'failed',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
});

export const JOB_DIRECTION = Object.freeze({
  OUTGOING: 'outgoing',
  INCOMING: 'incoming',
});

export const DIAGNOSTIC_CODE = Object.freeze({
  APP_RESTARTED: 'APP_RESTARTED',
  NETWORK_INTERRUPTED: 'NETWORK_INTERRUPTED',
  PEER_REVOKED: 'PEER_REVOKED',
  INTEGRITY_CHECK_FAILED: 'INTEGRITY_CHECK_FAILED',
  IO_ERROR: 'IO_ERROR',
  PROTOCOL_ERROR: 'PROTOCOL_ERROR',
  USER_CANCELLED: 'USER_CANCELLED',
});

export const SOURCE_MAPPING_STATUS = Object.freeze({
  AVAILABLE: 'available',
  MISSING: 'missing',
  NOT_APPLICABLE: 'not-applicable',
});

const MAX_ERROR_MESSAGE_LENGTH = 1024;
const RESTART_ERROR_MESSAGE = 'Transfer was interrupted because the application restarted';
const ALLOWED_DIAGNOSTIC_CODES: Set<string> = new Set(Object.values(DIAGNOSTIC_CODE));
const TRANSITIONS: Record<string, Set<string>> = {
  [JOB_STATUS.QUEUED]: new Set([JOB_STATUS.TRANSFERRING, JOB_STATUS.CANCELLED, JOB_STATUS.FAILED]),
  [JOB_STATUS.AWAITING_APPROVAL]: new Set([JOB_STATUS.QUEUED, JOB_STATUS.CANCELLED, JOB_STATUS.FAILED]),
  [JOB_STATUS.TRANSFERRING]: new Set([JOB_STATUS.PAUSED, JOB_STATUS.FAILED, JOB_STATUS.COMPLETED, JOB_STATUS.CANCELLED]),
  [JOB_STATUS.PAUSED]: new Set([JOB_STATUS.QUEUED, JOB_STATUS.CANCELLED, JOB_STATUS.FAILED]),
  [JOB_STATUS.FAILED]: new Set([JOB_STATUS.QUEUED, JOB_STATUS.CANCELLED]),
  [JOB_STATUS.COMPLETED]: new Set(),
  [JOB_STATUS.CANCELLED]: new Set(),
};

const JOB_FILE = 'transfer-jobs.json';

export interface JobSource {
  path: string;
  sourcePath: string;
  size: number;
  sha256: string;
}

export interface JobFileProgress {
  path: string;
  transferredBytes: number;
  completed: boolean;
}

export interface OutgoingCheckpoint {
  files: Array<{ path: string; size: number; committedOffset: number; completed: boolean }>;
  nextSequence: number;
  totalTransferred: number;
}

export interface JobProgress {
  totalFiles: number;
  completedFiles: number;
  totalBytes: number;
  transferredBytes: number;
}

export interface TransferJob {
  taskId: string;
  peerDeviceId: string;
  direction: string;
  status: string;
  manifest: TransferManifest;
  sources: JobSource[];
  sourceMappingStatus: string;
  recoverable: boolean;
  progress: JobProgress;
  createdAt: number;
  updatedAt: number;
  errorMessage: string | null;
  diagnosticCode: string | null;
  files: JobFileProgress[];
  outgoingCheckpoint: OutgoingCheckpoint | null;
}

export interface TrustedPeerStoreLike {
  getTrustedPeer(deviceId: string): unknown;
}

export class TransferJobStore {
  private filePath: string;
  private jobs = new Map<string, TransferJob>();
  trustedPeerStore: TrustedPeerStoreLike;

  constructor(userDataDir: string, trustedPeerStore: TrustedPeerStoreLike) {
    if (typeof userDataDir !== 'string' || userDataDir.trim().length === 0) throw new TypeError('A user-data directory is required');
    if (!trustedPeerStore || typeof trustedPeerStore.getTrustedPeer !== 'function') throw new TypeError('A trusted peer store is required');
    mkdirSync(userDataDir, { recursive: true });
    this.trustedPeerStore = trustedPeerStore;
    this.filePath = join(userDataDir, JOB_FILE);
    this.load();
    this.recoverInterruptedJobs();
  }

  private load(): void {
    if (!existsSync(this.filePath)) return;
    try {
      const data = JSON.parse(readFileSync(this.filePath, 'utf8'));
      if (Array.isArray(data)) {
        for (const persisted of data) {
          try {
            const job = this.normalizePersistedJob(persisted);
            this.jobs.set(job.taskId, job);
          } catch {
            // Quarantine malformed legacy entries by omitting only that job.
          }
        }
      }
    } catch {
      // Corrupt file — start fresh
    }
  }

  private save(): void {
    const data = Array.from(this.jobs.values()).map((job) => ({
      ...job,
      manifestSerialized: serializeTransferManifest(job.manifest),
    }));
    writeFileSync(this.filePath, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  }

  private recoverInterruptedJobs(): void {
    const now = Date.now();
    for (const job of this.jobs.values()) {
      if (job.status === JOB_STATUS.TRANSFERRING || job.status === JOB_STATUS.PAUSED) {
        job.status = JOB_STATUS.FAILED;
        job.diagnosticCode = DIAGNOSTIC_CODE.APP_RESTARTED;
        job.errorMessage = RESTART_ERROR_MESSAGE;
        job.updatedAt = now;
      }
    }
    this.save();
  }

  queueOutgoing({ peerDeviceId, manifest, sources, now = Date.now() }: { peerDeviceId: string; manifest: TransferManifest; sources: JobSource[]; now?: number }): TransferJob {
    return this.createJob({ peerDeviceId, manifest, sources, direction: JOB_DIRECTION.OUTGOING, status: JOB_STATUS.QUEUED, now });
  }

  receivePending({ peerDeviceId, manifest, sources, now = Date.now() }: { peerDeviceId: string; manifest: TransferManifest; sources: JobSource[]; now?: number }): TransferJob {
    return this.createJob({ peerDeviceId, manifest, sources, direction: JOB_DIRECTION.INCOMING, status: JOB_STATUS.AWAITING_APPROVAL, now });
  }

  private createJob({ peerDeviceId, manifest, sources, direction, status, now }: { peerDeviceId: string; manifest: TransferManifest; sources: JobSource[]; direction: string; status: string; now: number }): TransferJob {
    const normalized = normalizeTransferManifest(manifest);
    assertValidTaskId(normalized.taskId);
    if (this.jobs.has(normalized.taskId)) throw new Error(`Transfer job already exists: ${normalized.taskId}`);
    if (typeof peerDeviceId !== 'string' || peerDeviceId.length === 0) throw new TypeError('A peer device ID is required');
    const normalizedSources = normalizeSources(direction, sources, normalized);
    const files = normalized.entries.filter((e) => e.kind === 'file').map((e) => ({ path: (e as Extract<ManifestEntry, { kind: 'file' }>).path, transferredBytes: 0, completed: false }));
    const sourceMappingStatus = direction === JOB_DIRECTION.OUTGOING
      ? SOURCE_MAPPING_STATUS.AVAILABLE
      : SOURCE_MAPPING_STATUS.NOT_APPLICABLE;
    const job: TransferJob = {
      taskId: normalized.taskId,
      peerDeviceId,
      direction,
      status,
      manifest: normalized,
      sources: normalizedSources,
      sourceMappingStatus,
      recoverable: true,
      progress: {
        totalFiles: normalized.totalFiles,
        completedFiles: 0,
        totalBytes: normalized.totalBytes,
        transferredBytes: 0,
      },
      createdAt: now,
      updatedAt: now,
      errorMessage: null,
      diagnosticCode: null,
      files,
      outgoingCheckpoint: direction === JOB_DIRECTION.OUTGOING ? initialOutgoingCheckpoint(normalized) : null,
    };
    this.jobs.set(job.taskId, job);
    this.save();
    return this.sanitize(job);
  }

  approveIncoming(taskId: string, now: number = Date.now()): TransferJob {
    return this.transition(taskId, JOB_STATUS.QUEUED, now);
  }

  start(taskId: string, now: number = Date.now()): TransferJob {
    return this.transition(taskId, JOB_STATUS.TRANSFERRING, now);
  }

  pause(taskId: string, now: number = Date.now()): TransferJob {
    return this.transition(taskId, JOB_STATUS.PAUSED, now);
  }

  resume(taskId: string, now: number = Date.now()): TransferJob {
    if (!this.requireJob(taskId).recoverable) throw new Error('Transfer job is not recoverable');
    return this.transition(taskId, JOB_STATUS.QUEUED, now);
  }

  retry(taskId: string, now: number = Date.now()): TransferJob {
    if (!this.requireJob(taskId).recoverable) throw new Error('Transfer job is not recoverable');
    return this.transition(taskId, JOB_STATUS.QUEUED, now);
  }

  fail(taskId: string, diagnosticCode: string, now: number = Date.now(), errorMessage: string | null = null): TransferJob {
    if (!ALLOWED_DIAGNOSTIC_CODES.has(diagnosticCode)) throw new TypeError('Invalid diagnostic code');
    const job = this.requireJob(taskId);
    this.assertTransition(job.status, JOB_STATUS.FAILED);
    job.status = JOB_STATUS.FAILED;
    job.diagnosticCode = diagnosticCode;
    job.errorMessage = errorMessage ? String(errorMessage).slice(0, MAX_ERROR_MESSAGE_LENGTH) : null;
    job.recoverable = job.direction !== JOB_DIRECTION.OUTGOING || job.sourceMappingStatus === SOURCE_MAPPING_STATUS.AVAILABLE;
    job.updatedAt = now;
    this.save();
    return this.sanitize(job);
  }

  cancel(taskId: string, now: number = Date.now()): TransferJob {
    const job = this.requireJob(taskId);
    this.assertTransition(job.status, JOB_STATUS.CANCELLED);
    job.status = JOB_STATUS.CANCELLED;
    job.recoverable = false;
    job.updatedAt = now;
    this.save();
    return this.sanitize(job);
  }

  complete(taskId: string, now: number = Date.now()): TransferJob {
    return this.transition(taskId, JOB_STATUS.COMPLETED, now);
  }

  recordFileProgress(taskId: string, relativePath: string, transferredBytes: number, now: number = Date.now()): TransferJob {
    const job = this.requireJob(taskId);
    if (job.status !== JOB_STATUS.TRANSFERRING) throw new Error('File progress can only be recorded while transferring');
    const file = job.files.find((f) => f.path === relativePath);
    if (!file) throw new Error('File progress path is not declared by the transfer manifest');
    const manifestFile = job.manifest.entries.find((entry) => entry.kind === 'file' && entry.path === relativePath) as Extract<ManifestEntry, { kind: 'file' }> | undefined;
    if (!manifestFile) throw new Error('File progress path is not declared by the transfer manifest');
    if (!Number.isSafeInteger(transferredBytes) || transferredBytes < file.transferredBytes) {
      throw new RangeError('File progress must be a monotonic non-negative safe integer');
    }
    if (transferredBytes > manifestFile.size) throw new RangeError('File progress exceeds the manifest file size');
    file.transferredBytes = transferredBytes;
    file.completed = transferredBytes === manifestFile.size;
    refreshProgress(job);
    job.updatedAt = now;
    this.save();
    return this.sanitize(job);
  }

  getOutgoingCheckpoint(taskId: string): OutgoingCheckpoint | null {
    const job = this.requireJob(taskId);
    if (job.direction !== JOB_DIRECTION.OUTGOING) throw new Error('Outgoing checkpoints are only available for outgoing transfers');
    return job.outgoingCheckpoint ? cloneCheckpoint(job.outgoingCheckpoint) : initialOutgoingCheckpoint(job.manifest);
  }

  advanceOutgoingCheckpoint(taskId: string, checkpoint: OutgoingCheckpoint, now: number = Date.now()): TransferJob {
    const job = this.requireJob(taskId);
    if (job.direction !== JOB_DIRECTION.OUTGOING) throw new Error('Outgoing checkpoints can only advance outgoing transfers');
    if (job.status !== JOB_STATUS.TRANSFERRING) throw new Error('Outgoing checkpoints can only advance while transferring');
    const current = job.outgoingCheckpoint ?? initialOutgoingCheckpoint(job.manifest);
    const candidate = normalizeCheckpoint(checkpoint, current);
    job.outgoingCheckpoint = candidate;
    for (const checkpointFile of candidate.files) {
      const file = job.files.find((entry) => entry.path === checkpointFile.path)!;
      file.transferredBytes = checkpointFile.committedOffset;
      file.completed = checkpointFile.completed;
    }
    refreshProgress(job);
    job.updatedAt = now;
    this.save();
    return this.sanitize(job);
  }

  get(taskId: string): TransferJob | null {
    const job = this.jobs.get(taskId);
    return job ? this.sanitize(job) : null;
  }

  list({ includeTerminal = false } = {}): TransferJob[] {
    const result: TransferJob[] = [];
    for (const job of this.jobs.values()) {
      if (includeTerminal || (job.status !== JOB_STATUS.COMPLETED && job.status !== JOB_STATUS.CANCELLED)) {
        result.push(this.sanitize(job));
      }
    }
    return result.sort((a, b) => a.createdAt - b.createdAt);
  }

  listRecoverable(): TransferJob[] {
    return this.list().filter((job) => job.recoverable && (job.status === JOB_STATUS.FAILED || job.status === JOB_STATUS.PAUSED));
  }

  getFiles(taskId: string): JobFileProgress[] {
    const job = this.jobs.get(taskId);
    return job ? job.files.map((f) => ({ ...f })) : [];
  }

  close(): void {
    this.save();
  }

  private transition(taskId: string, newStatus: string, now: number): TransferJob {
    const job = this.requireJob(taskId);
    this.assertTransition(job.status, newStatus);
    if (newStatus === JOB_STATUS.TRANSFERRING && job.direction === JOB_DIRECTION.OUTGOING &&
        job.sourceMappingStatus !== SOURCE_MAPPING_STATUS.AVAILABLE) {
      throw new Error('Outgoing transfer source file mappings are unavailable');
    }
    if (newStatus === JOB_STATUS.COMPLETED &&
        (job.progress.transferredBytes !== job.progress.totalBytes ||
         job.progress.completedFiles !== job.progress.totalFiles ||
         job.files.some((file) => !file.completed))) {
      throw new Error('Transfer cannot complete before every manifest file is committed');
    }
    job.status = newStatus;
    job.recoverable = newStatus !== JOB_STATUS.COMPLETED && newStatus !== JOB_STATUS.CANCELLED &&
      (job.direction !== JOB_DIRECTION.OUTGOING || job.sourceMappingStatus === SOURCE_MAPPING_STATUS.AVAILABLE);
    job.updatedAt = now;
    this.save();
    return this.sanitize(job);
  }

  private requireJob(taskId: string): TransferJob {
    const job = this.jobs.get(taskId);
    if (!job) throw new Error(`Transfer job not found: ${taskId}`);
    return job;
  }

  private assertTransition(from: string, to: string): void {
    const allowed = TRANSITIONS[from];
    if (!allowed || !allowed.has(to)) throw new Error(`Invalid job transition: ${from} → ${to}`);
  }

  private sanitize(job: TransferJob): TransferJob {
    return {
      ...job,
      manifest: job.manifest,
      sources: job.sources.map((s) => ({ ...s })),
      progress: { ...job.progress },
      files: job.files.map((f) => ({ ...f })),
      outgoingCheckpoint: job.outgoingCheckpoint ? cloneCheckpoint(job.outgoingCheckpoint) : null,
    };
  }

  private normalizePersistedJob(value: unknown): TransferJob {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Persisted transfer job is invalid');
    const raw = value as Record<string, any>;
    const manifest = parsePersistedTransferManifest(raw.manifestSerialized ?? serializeTransferManifest(raw.manifest));
    if (raw.taskId !== manifest.taskId || (raw.direction !== JOB_DIRECTION.OUTGOING && raw.direction !== JOB_DIRECTION.INCOMING)) {
      throw new Error('Persisted transfer job identity is invalid');
    }
    const expectedFiles = manifest.entries.filter((entry) => entry.kind === 'file') as Array<Extract<ManifestEntry, { kind: 'file' }>>;
    const persistedProgress = Array.isArray(raw.files)
      ? new Map(raw.files.map((file: any) => [file?.path, file?.transferredBytes]))
      : new Map<string, number>();
    const files = expectedFiles.map((entry) => {
      const transferredBytes = persistedProgress.get(entry.path) ?? 0;
      if (!Number.isSafeInteger(transferredBytes) || transferredBytes < 0 || transferredBytes > entry.size) {
        throw new RangeError('Persisted transfer file progress is invalid');
      }
      const completed = typeof (raw.files?.find((file: any) => file?.path === entry.path)?.completed) === 'boolean'
        ? raw.files.find((file: any) => file?.path === entry.path).completed
        : entry.size > 0 && transferredBytes === entry.size;
      if ((completed && transferredBytes !== entry.size) || (!completed && entry.size > 0 && transferredBytes === entry.size)) {
        throw new Error('Persisted transfer file completion marker is invalid');
      }
      return { path: entry.path, transferredBytes, completed };
    });
    let sources: JobSource[] = [];
    let sourceMappingStatus: string = SOURCE_MAPPING_STATUS.NOT_APPLICABLE;
    if (raw.direction === JOB_DIRECTION.OUTGOING) {
      try {
        sources = normalizeSources(raw.direction, raw.sources, manifest);
        sourceMappingStatus = SOURCE_MAPPING_STATUS.AVAILABLE;
      } catch {
        sources = [];
        sourceMappingStatus = SOURCE_MAPPING_STATUS.MISSING;
      }
    }
    const job: TransferJob = {
      taskId: raw.taskId,
      peerDeviceId: String(raw.peerDeviceId ?? ''),
      direction: raw.direction,
      status: String(raw.status),
      manifest,
      sources,
      sourceMappingStatus,
      recoverable: false,
      progress: { totalFiles: manifest.totalFiles, completedFiles: 0, totalBytes: manifest.totalBytes, transferredBytes: 0 },
      createdAt: Number(raw.createdAt),
      updatedAt: Number(raw.updatedAt),
      errorMessage: raw.errorMessage === null ? null : String(raw.errorMessage ?? '').slice(0, MAX_ERROR_MESSAGE_LENGTH),
      diagnosticCode: raw.diagnosticCode === null ? null : String(raw.diagnosticCode ?? ''),
      files,
      outgoingCheckpoint: null,
    };
    if (!Number.isFinite(job.createdAt) || !Number.isFinite(job.updatedAt)) throw new TypeError('Persisted transfer timestamps are invalid');
    refreshProgress(job);
    if (job.direction === JOB_DIRECTION.OUTGOING) {
      const initial = checkpointFromFileProgress(job);
      job.outgoingCheckpoint = raw.outgoingCheckpoint
        ? normalizeCheckpoint(raw.outgoingCheckpoint, initial, { allowEqual: true })
        : initial;
      for (const checkpointFile of job.outgoingCheckpoint.files) {
        const file = job.files.find((entry) => entry.path === checkpointFile.path)!;
        file.transferredBytes = checkpointFile.committedOffset;
        file.completed = checkpointFile.completed;
      }
      refreshProgress(job);
    }
    job.recoverable = job.status !== JOB_STATUS.COMPLETED && job.status !== JOB_STATUS.CANCELLED &&
      (job.direction !== JOB_DIRECTION.OUTGOING || job.sourceMappingStatus === SOURCE_MAPPING_STATUS.AVAILABLE);
    return job;
  }
}

function normalizeSources(direction: string, value: unknown, manifest: TransferManifest): JobSource[] {
  if (!Array.isArray(value)) throw new TypeError('Transfer sources must be an array');
  if (direction === JOB_DIRECTION.INCOMING) {
    if (value.length !== 0) throw new TypeError('Incoming transfer jobs must not contain local source mappings');
    return [];
  }
  const files = manifest.entries.filter((entry) => entry.kind === 'file') as Array<Extract<ManifestEntry, { kind: 'file' }>>;
  if (value.length !== files.length) throw new Error('Outgoing transfer sources must match every manifest file exactly once');
  const expected = new Map(files.map((file) => [file.path, file]));
  const seen = new Set<string>();
  return value.map((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError('Transfer source mapping must be an object');
    const source = raw as Record<string, unknown>;
    if (typeof source.path !== 'string' || seen.has(source.path)) throw new Error('Transfer source mappings contain a duplicate or invalid path');
    const file = expected.get(source.path);
    if (!file || typeof source.sourcePath !== 'string' || source.sourcePath.length === 0 || source.sourcePath.includes('\0') ||
        !isAbsolute(source.sourcePath) || source.size !== file.size || source.sha256 !== file.sha256) {
      throw new Error('Transfer source metadata does not match the manifest');
    }
    seen.add(source.path);
    return { path: source.path, sourcePath: source.sourcePath, size: file.size, sha256: file.sha256 };
  });
}

function initialOutgoingCheckpoint(manifest: TransferManifest): OutgoingCheckpoint {
  return {
    files: (manifest.entries.filter((entry) => entry.kind === 'file') as Array<Extract<ManifestEntry, { kind: 'file' }>>)
      .map((entry) => ({ path: entry.path, size: entry.size, committedOffset: 0, completed: false })),
    nextSequence: 0,
    totalTransferred: 0,
  };
}

function checkpointFromFileProgress(job: TransferJob): OutgoingCheckpoint {
  const files = job.manifest.entries.filter((entry) => entry.kind === 'file') as Array<Extract<ManifestEntry, { kind: 'file' }>>;
  return {
    files: files.map((entry) => {
      const transferredBytes = job.files.find((file) => file.path === entry.path)?.transferredBytes ?? 0;
      const completed = job.files.find((file) => file.path === entry.path)?.completed ?? false;
      return { path: entry.path, size: entry.size, committedOffset: transferredBytes, completed };
    }),
    nextSequence: 0,
    totalTransferred: job.files.reduce((sum, file) => sum + file.transferredBytes, 0),
  };
}

function normalizeCheckpoint(value: unknown, current: OutgoingCheckpoint, options: { allowEqual?: boolean } = {}): OutgoingCheckpoint {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Outgoing checkpoint is invalid');
  const raw = value as Record<string, unknown>;
  const keys = Object.keys(raw).sort().join(',');
  if (keys !== 'files,nextSequence,totalTransferred') throw new TypeError('Outgoing checkpoint fields are invalid');
  if (!Array.isArray(raw.files) || raw.files.length !== current.files.length ||
      !Number.isSafeInteger(raw.nextSequence) || (raw.nextSequence as number) < current.nextSequence ||
      !Number.isSafeInteger(raw.totalTransferred) || (raw.totalTransferred as number) < current.totalTransferred) {
    throw new RangeError('Outgoing checkpoint is not monotonic');
  }
  let totalTransferred = 0;
  const files = raw.files.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new TypeError('Outgoing checkpoint file is invalid');
    const file = entry as Record<string, unknown>;
    const expected = current.files[index]!;
    if (Object.keys(file).sort().join(',') !== 'committedOffset,completed,path,size' || file.path !== expected.path || file.size !== expected.size ||
        !Number.isSafeInteger(file.committedOffset) || (file.committedOffset as number) < expected.committedOffset || (file.committedOffset as number) > expected.size ||
        ((file.completed === true) && file.committedOffset !== expected.size) ||
        ((file.completed === false) && expected.size > 0 && file.committedOffset === expected.size) ||
        typeof file.completed !== 'boolean') {
      throw new Error('Outgoing checkpoint file metadata is invalid or non-monotonic');
    }
    totalTransferred += file.committedOffset as number;
    return { path: expected.path, size: expected.size, committedOffset: file.committedOffset as number, completed: file.completed as boolean };
  });
  if (totalTransferred !== raw.totalTransferred || (!options.allowEqual && raw.totalTransferred === current.totalTransferred && raw.nextSequence === current.nextSequence)) {
    throw new Error('Outgoing checkpoint aggregate progress is invalid');
  }
  return { files, nextSequence: raw.nextSequence as number, totalTransferred };
}

function refreshProgress(job: TransferJob): void {
  job.progress.transferredBytes = job.files.reduce((sum, file) => sum + file.transferredBytes, 0);
  job.progress.completedFiles = job.files.reduce((sum, file) => sum + (file.completed ? 1 : 0), 0);
}

function cloneCheckpoint(checkpoint: OutgoingCheckpoint): OutgoingCheckpoint {
  return { ...checkpoint, files: checkpoint.files.map((file) => ({ ...file })) };
}

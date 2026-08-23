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
import { join } from 'node:path';
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
}

export interface OutgoingCheckpoint {
  taskId: string;
  senderDeviceId: string;
  receiverDeviceId: string;
  manifestHash: string;
  files: Array<{ path: string; size: number; committedOffset: number; completed: boolean }>;
  nextSequence: number;
  totalTransferred: number;
  issuedAt: number;
}

export interface TransferJob {
  taskId: string;
  peerDeviceId: string;
  direction: string;
  status: string;
  manifest: TransferManifest;
  sources: JobSource[];
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
        for (const job of data) {
          if (job && typeof job.taskId === 'string') {
            job.manifest = parsePersistedTransferManifest(job.manifestSerialized ?? serializeTransferManifest(job.manifest));
            this.jobs.set(job.taskId, job as TransferJob);
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
    const files = normalized.entries.filter((e) => e.kind === 'file').map((e) => ({ path: (e as Extract<ManifestEntry, { kind: 'file' }>).path, transferredBytes: 0 }));
    const job: TransferJob = {
      taskId: normalized.taskId,
      peerDeviceId,
      direction,
      status,
      manifest: normalized,
      sources,
      createdAt: now,
      updatedAt: now,
      errorMessage: null,
      diagnosticCode: null,
      files,
      outgoingCheckpoint: null,
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
    return this.transition(taskId, JOB_STATUS.QUEUED, now);
  }

  retry(taskId: string, now: number = Date.now()): TransferJob {
    return this.transition(taskId, JOB_STATUS.QUEUED, now);
  }

  fail(taskId: string, diagnosticCode: string, now: number = Date.now(), errorMessage: string | null = null): TransferJob {
    if (!ALLOWED_DIAGNOSTIC_CODES.has(diagnosticCode)) throw new TypeError('Invalid diagnostic code');
    const job = this.requireJob(taskId);
    this.assertTransition(job.status, JOB_STATUS.FAILED);
    job.status = JOB_STATUS.FAILED;
    job.diagnosticCode = diagnosticCode;
    job.errorMessage = errorMessage ? String(errorMessage).slice(0, MAX_ERROR_MESSAGE_LENGTH) : null;
    job.updatedAt = now;
    this.save();
    return this.sanitize(job);
  }

  cancel(taskId: string, now: number = Date.now()): TransferJob {
    const job = this.requireJob(taskId);
    this.assertTransition(job.status, JOB_STATUS.CANCELLED);
    job.status = JOB_STATUS.CANCELLED;
    job.updatedAt = now;
    this.save();
    return this.sanitize(job);
  }

  complete(taskId: string, now: number = Date.now()): TransferJob {
    return this.transition(taskId, JOB_STATUS.COMPLETED, now);
  }

  recordFileProgress(taskId: string, relativePath: string, transferredBytes: number, now: number = Date.now()): TransferJob {
    const job = this.requireJob(taskId);
    const file = job.files.find((f) => f.path === relativePath);
    if (file) file.transferredBytes = transferredBytes;
    job.updatedAt = now;
    this.save();
    return this.sanitize(job);
  }

  getOutgoingCheckpoint(taskId: string): OutgoingCheckpoint | null {
    const job = this.jobs.get(taskId);
    return job?.outgoingCheckpoint ?? null;
  }

  advanceOutgoingCheckpoint(taskId: string, checkpoint: OutgoingCheckpoint, now: number = Date.now()): TransferJob {
    const job = this.requireJob(taskId);
    job.outgoingCheckpoint = checkpoint;
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
    return this.list().filter((job) => job.status === JOB_STATUS.FAILED || job.status === JOB_STATUS.PAUSED);
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
    job.status = newStatus;
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
    return { ...job, manifest: job.manifest, sources: job.sources.map((s) => ({ ...s })), files: job.files.map((f) => ({ ...f })) };
  }
}

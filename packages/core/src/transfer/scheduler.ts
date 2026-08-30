/**
 * Desktop transfer scheduler: coordinates persisted transfer jobs with one
 * injected runtime executor. Ported from src/v2/desktop-transfer-scheduler.js.
 *
 * The executor contract is deliberately small so the scheduler does not know
 * how a LAN connection or a TransferStreamSession is created:
 *   await executorFactory({ job, checkpoint, signal, commitRemoteCheckpoint })
 *   executor.done       Promise which resolves on success or rejects on error
 *   executor.pause()    Promise which resolves after the stream is paused
 *   executor.resume()   Promise which resolves after the stream is resumed
 *   executor.cancel()   Promise which resolves after the stream is stopped
 */

import { DIAGNOSTIC_CODE, JOB_DIRECTION, JOB_STATUS, type TransferJob, type OutgoingCheckpoint } from './job-store.js';

const SUPPORTED_DIAGNOSTIC_CODES: Set<string> = new Set(Object.values(DIAGNOSTIC_CODE));

export interface TransferExecutor {
  done: Promise<unknown>;
  pause?(): Promise<unknown>;
  resume?(): Promise<unknown>;
  cancel?(reason?: unknown): Promise<unknown>;
  close?(): Promise<unknown>;
  destroy?(): Promise<unknown>;
  dispose?(): Promise<unknown>;
}

export interface ExecutorFactoryArgs {
  job: TransferJob;
  checkpoint: OutgoingCheckpoint | null;
  signal: AbortSignal;
  commitRemoteCheckpoint: (checkpoint: OutgoingCheckpoint, now?: number) => TransferJob;
}

export type ExecutorFactory = (args: ExecutorFactoryArgs) => TransferExecutor | Promise<TransferExecutor>;

export interface TransferJobStoreLike {
  list(opts?: { includeTerminal?: boolean }): TransferJob[];
  start(taskId: string, now?: number): TransferJob;
  pause(taskId: string, now?: number): TransferJob;
  resume(taskId: string, now?: number): TransferJob;
  retry(taskId: string, now?: number): TransferJob;
  cancel(taskId: string, now?: number): TransferJob;
  complete(taskId: string, now?: number): TransferJob;
  fail(taskId: string, diagnosticCode: string, now?: number, errorMessage?: string | null): TransferJob;
  get(taskId: string): TransferJob | null;
  getOutgoingCheckpoint(taskId: string): OutgoingCheckpoint | null;
  advanceOutgoingCheckpoint(taskId: string, checkpoint: OutgoingCheckpoint, now?: number): TransferJob;
}

export interface SchedulerOptions {
  transferJobStore: TransferJobStoreLike;
  executorFactory: ExecutorFactory;
  maxConcurrentJobs?: number;
}

interface ActiveJob {
  job: TransferJob;
  executor: TransferExecutor | null;
  executorReady: Promise<void> | null;
  controller: AbortController;
  doneResult: { error: Error | null } | null;
  settled: boolean;
  cleanupRequested: boolean;
  cleanupReason: unknown;
  cleanupPromise?: Promise<void>;
}

export class DesktopTransferScheduler {
  public transferJobStore: TransferJobStoreLike;
  public executorFactory: ExecutorFactory;
  private _running: boolean;
  private _active: ActiveJob | null;
  private _commandTail: Promise<unknown>;

  constructor({ transferJobStore, executorFactory, maxConcurrentJobs = 1 }: SchedulerOptions) {
    if (!transferJobStore || typeof transferJobStore.list !== 'function') {
      throw new TypeError('A transfer job store is required');
    }
    if (typeof executorFactory !== 'function') {
      throw new TypeError('An executor factory is required');
    }
    if (maxConcurrentJobs !== 1) {
      throw new RangeError('The desktop transfer scheduler supports exactly one concurrent job');
    }

    this.transferJobStore = transferJobStore;
    this.executorFactory = executorFactory;
    this._running = false;
    this._active = null;
    this._commandTail = Promise.resolve();
  }

  start(): Promise<TransferJob | null> {
    return this._enqueue(async () => {
      this._running = true;
      await this._pump();
      return this.getActiveJob();
    });
  }

  kick(): Promise<TransferJob | null> {
    return this._enqueue(async () => {
      await this._pump();
      return this.getActiveJob();
    });
  }

  pause(taskId: string): Promise<TransferJob | null> {
    return this._enqueue(async () => {
      const active = this._requireActive(taskId);
      await this._waitForExecutor(active);
      if (active.job.status !== JOB_STATUS.TRANSFERRING) return active.job;
      if (!active.executor || typeof active.executor.pause !== 'function') {
        throw new Error('The active transfer executor does not support pause');
      }
      await active.executor.pause();
      if (active.doneResult) {
        return this._finishActive(active, active.doneResult.error);
      }
      if (this._active !== active || active.job.status !== JOB_STATUS.TRANSFERRING) {
        return active.job;
      }
      active.job = this.transferJobStore.pause(taskId);
      return active.job;
    });
  }

  resume(taskId: string): Promise<TransferJob | null> {
    return this._enqueue(async () => {
      const active = this._active && this._active.job.taskId === taskId ? this._active : null;
      if (!active) {
        const job = this.transferJobStore.resume(taskId);
        await this._pump();
        return job;
      }
      await this._waitForExecutor(active);
      if (active.job.status !== JOB_STATUS.PAUSED) return active.job;
      if (!active.executor || typeof active.executor.resume !== 'function') {
        throw new Error('The active transfer executor does not support resume');
      }
      await active.executor.resume();
      if (this._active !== active || active.job.status !== JOB_STATUS.PAUSED) {
        return active.job;
      }
      active.job = this.transferJobStore.resume(taskId);
      active.job = this.transferJobStore.start(taskId);
      return active.job;
    });
  }

  retry(taskId: string): Promise<TransferJob | null> {
    return this._enqueue(async () => {
      const job = this.transferJobStore.retry(taskId);
      await this._pump();
      return job;
    });
  }

  cancel(taskId: string): Promise<TransferJob | null> {
    return this._enqueue(async () => {
      const active = this._active && this._active.job.taskId === taskId ? this._active : null;
      if (!active) {
        const current = this.transferJobStore.get(taskId);
        if (current && (current.status === JOB_STATUS.CANCELLED || current.status === JOB_STATUS.COMPLETED)) {
          return current;
        }
        return this.transferJobStore.cancel(taskId);
      }

      active.settled = true;
      const cleanup = this._cleanupExecutor(active, new Error('Transfer cancelled by the user'));
      active.job = this.transferJobStore.cancel(taskId);
      if (this._active === active) this._active = null;
      void cleanup.catch(() => {});
      await this._pump();
      return active.job;
    });
  }

  stop(): Promise<TransferJob | null> {
    return this._enqueue(async () => {
      this._running = false;
      const active = this._active;
      if (!active) return null;

      active.settled = true;
      const cleanup = this._cleanupExecutor(active, new Error('Transfer scheduler stopped'));
      if (active.job.status === JOB_STATUS.TRANSFERRING) {
        active.job = this.transferJobStore.pause(taskIdOf(active));
      }
      if (this._active === active) this._active = null;
      void cleanup.catch(() => {});
      return active.job;
    });
  }

  getActiveJob(): TransferJob | null {
    return this._active ? this._active.job : null;
  }

  private _enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this._commandTail.then(operation);
    this._commandTail = result.catch(() => {});
    return result;
  }

  private async _pump(): Promise<void> {
    while (this._running && !this._active) {
      const job = this.transferJobStore.list({ includeTerminal: false })
        .find((candidate) => candidate.direction === JOB_DIRECTION.OUTGOING &&
          candidate.status === JOB_STATUS.QUEUED && candidate.recoverable !== false);
      if (!job) return;

      let started: TransferJob;
      try {
        started = this.transferJobStore.start(job.taskId);
      } catch (error) {
        if (isMissingSourceMappingError(error)) {
          continue;
        }
        this._markFailed(job.taskId, error);
        continue;
      }

      const active: ActiveJob = {
        job: started,
        executor: null,
        executorReady: null,
        controller: new AbortController(),
        doneResult: null,
        settled: false,
        cleanupRequested: false,
        cleanupReason: null,
      };
      this._active = active;
      active.executorReady = this._createExecutor(active);
      void active.executorReady.catch((error: unknown) => {
        if (this._active !== active || active.settled) return;
        const failure = error instanceof Error ? error : new Error(String(error));
        void this._enqueue(() => this._finishActive(active, failure)).catch(() => {});
      });
      break;
    }
  }

  private async _createExecutor(active: ActiveJob): Promise<void> {
    const checkpoint = this.transferJobStore.getOutgoingCheckpoint(active.job.taskId);
    const executor = await this.executorFactory({
      job: active.job,
      checkpoint,
      signal: active.controller.signal,
      commitRemoteCheckpoint: (candidate: OutgoingCheckpoint, now?: number): TransferJob => {
        if (this._active !== active || active.job.status !== JOB_STATUS.TRANSFERRING) {
          throw new Error('Transfer executor committed a checkpoint for an inactive job');
        }
        const committed = this.transferJobStore.advanceOutgoingCheckpoint(
          active.job.taskId,
          candidate,
          now,
        );
        active.job = this.transferJobStore.get(active.job.taskId)!;
        return committed;
      },
    });
    assertExecutor(executor);
    active.executor = executor;
    if (this._active !== active || active.settled || active.cleanupRequested) return;
    Promise.resolve(executor.done).then(
      () => {
        if (this._active !== active || active.settled) return;
        active.doneResult = { error: null };
        return this._enqueue(() => this._finishActive(active, null)).catch(() => {});
      },
      (error: unknown) => {
        if (this._active !== active || active.settled) return;
        const failure = error === null || error === undefined ? new Error('Transfer executor failed') : (error instanceof Error ? error : new Error(String(error)));
        active.doneResult = { error: failure };
        return this._enqueue(() => this._finishActive(active, failure)).catch(() => {});
      },
    );
  }

  private async _finishActive(active: ActiveJob, error: Error | null): Promise<TransferJob | null> {
    if (this._active !== active || active.settled) return active.job;
    active.settled = true;
    try {
      if (error === null) {
        try {
          active.job = this.transferJobStore.complete(active.job.taskId);
        } catch (completionError) {
          error = completionError as Error;
        }
      }
      if (error !== null) {
        await this._cleanupExecutor(active, error);
        if (this._active === active && active.job.status === JOB_STATUS.TRANSFERRING) {
          active.job = this._markFailed(active.job.taskId, error);
        }
      } else {
        await this._cleanupExecutor(active, null);
      }
      return active.job;
    } finally {
      if (this._active === active) this._active = null;
      await this._pump();
    }
  }

  private _cleanupExecutor(active: ActiveJob, reason: unknown): Promise<void> {
    if (active.cleanupPromise) return active.cleanupPromise;
    active.cleanupRequested = true;
    active.cleanupReason = reason;
    active.controller.abort(reason);
    active.cleanupPromise = (async () => {
      if (active.executorReady) {
        try {
          await active.executorReady;
        } catch {
          // A rejected factory produced no executor to clean up.
        }
      }
      await cleanupExecutor(active.executor, active.cleanupReason);
    })();
    return active.cleanupPromise;
  }

  private async _waitForExecutor(active: ActiveJob): Promise<void> {
    if (active.executorReady) {
      try {
        await active.executorReady;
      } catch (error) {
        if (this._active === active && !active.settled) throw error;
      }
    }
    if (!active.executor) throw new Error('The active transfer executor is unavailable');
  }

  private _requireActive(taskId: string): ActiveJob {
    if (typeof taskId !== 'string' || !this._active || this._active.job.taskId !== taskId) {
      throw new Error('The requested transfer job is not active');
    }
    return this._active;
  }

  private _markFailed(taskId: string, error: unknown): TransferJob {
    const diagnosticCode = diagnosticCodeFor(error);
    try {
      return this.transferJobStore.fail(taskId, diagnosticCode, Date.now(), errorMessageFor(error));
    } catch (failureError: any) {
      if (/Illegal transfer job transition|not found/i.test(String(failureError.message))) {
        return this.transferJobStore.get(taskId)!;
      }
      throw failureError;
    }
  }
}

export function createDesktopTransferScheduler(options: SchedulerOptions): DesktopTransferScheduler {
  return new DesktopTransferScheduler(options);
}

function assertExecutor(executor: unknown): void {
  if (!executor || typeof executor !== 'object' || typeof (executor as any).done?.then !== 'function') {
    throw new TypeError('The executor factory must return an executor with a done promise');
  }
}

async function cleanupExecutor(executor: TransferExecutor | null, reason: unknown): Promise<void> {
  if (!executor) return;
  let firstError: unknown = null;
  if (reason !== null && typeof executor.cancel === 'function') {
    try {
      await executor.cancel(reason);
    } catch (error) {
      firstError = error;
    }
  }
  for (const method of ['close', 'destroy', 'dispose'] as const) {
    if (typeof (executor as any)[method] !== 'function') continue;
    try {
      await (executor as any)[method]();
    } catch (error) {
      if (!firstError) firstError = error;
    }
  }
  if (firstError && reason === null) throw firstError;
}

function diagnosticCodeFor(error: unknown): string {
  const err = error as any;
  if (err && SUPPORTED_DIAGNOSTIC_CODES.has(err.diagnosticCode)) return err.diagnosticCode;
  if (err && SUPPORTED_DIAGNOSTIC_CODES.has(err.code)) return err.code;
  const message = String(err && err.message ? err.message : err).toLowerCase();
  if (/integrity|checksum|hash/.test(message)) return DIAGNOSTIC_CODE.INTEGRITY_CHECK_FAILED;
  if (/protocol|frame|manifest|invalid control/.test(message)) return DIAGNOSTIC_CODE.PROTOCOL_ERROR;
  if (/peer|trust|revok/.test(message)) return DIAGNOSTIC_CODE.PEER_REVOKED;
  if (/network|socket|connection|timeout|econn|offline/.test(message)) return DIAGNOSTIC_CODE.NETWORK_INTERRUPTED;
  return DIAGNOSTIC_CODE.IO_ERROR;
}

function errorMessageFor(error: unknown): string {
  const err = error as any;
  const message = String(err && err.message ? err.message : err).trim();
  return message.slice(0, 1024) || 'Transfer executor failed';
}

function isMissingSourceMappingError(error: unknown): boolean {
  const err = error as any;
  return /source file mappings are unavailable/i.test(String(err && err.message ? err.message : err));
}

function taskIdOf(active: ActiveJob): string {
  return active.job.taskId;
}

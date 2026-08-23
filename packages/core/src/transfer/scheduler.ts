/**
 * Desktop transfer scheduler: coordinates persisted transfer jobs with one
 * injected runtime executor. Ported from src/v2/desktop-transfer-scheduler.js.
 *
 * The executor contract is deliberately small so the scheduler does not know
 * how a LAN connection or TransferStreamSession is created:
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

export interface SchedulerOptions {
  transferJobStore: {
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
  };
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
  cleanupPromise?: Promise<void>;
}

export class DesktopTransferScheduler {
  private transferJobStore: SchedulerOptions['transferJobStore'];
  private executorFactory: ExecutorFactory;
  private running = false;
  private active: ActiveJob | null = null;
  private commandTail: Promise<unknown> = Promise.resolve();

  constructor({ transferJobStore, executorFactory, maxConcurrentJobs = 1 }: SchedulerOptions) {
    if (!transferJobStore || typeof transferJobStore.list !== 'function') throw new TypeError('A transfer job store is required');
    if (typeof executorFactory !== 'function') throw new TypeError('An executor factory is required');
    if (maxConcurrentJobs !== 1) throw new RangeError('The desktop transfer scheduler supports exactly one concurrent job');
    this.transferJobStore = transferJobStore;
    this.executorFactory = executorFactory;
  }

  start(): Promise<TransferJob | null> {
    return this.enqueue(async () => {
      this.running = true;
      await this.pump();
      return this.getActiveJob();
    });
  }

  kick(): Promise<TransferJob | null> {
    return this.enqueue(async () => {
      await this.pump();
      return this.getActiveJob();
    });
  }

  pause(taskId: string): Promise<TransferJob> {
    return this.enqueue(async () => {
      const active = this.requireActive(taskId);
      await this.waitForExecutor(active);
      if (active.job.status !== JOB_STATUS.TRANSFERRING) return active.job;
      if (typeof active.executor?.pause !== 'function') throw new Error('The active transfer executor does not support pause');
      await active.executor.pause();
      if (active.doneResult) return this.finishActive(active, active.doneResult.error);
      if (this.active !== active || active.job.status !== JOB_STATUS.TRANSFERRING) return active.job;
      active.job = this.transferJobStore.pause(taskId);
      return active.job;
    });
  }

  resume(taskId: string): Promise<TransferJob> {
    return this.enqueue(async () => {
      const active = this.active && this.active.job.taskId === taskId ? this.active : null;
      if (!active) {
        const job = this.transferJobStore.resume(taskId);
        await this.pump();
        return job;
      }
      await this.waitForExecutor(active);
      if (active.job.status !== JOB_STATUS.PAUSED) return active.job;
      if (typeof active.executor?.resume !== 'function') throw new Error('The active transfer executor does not support resume');
      await active.executor.resume();
      if (this.active !== active || active.job.status !== JOB_STATUS.PAUSED) return active.job;
      active.job = this.transferJobStore.resume(taskId);
      active.job = this.transferJobStore.start(taskId);
      return active.job;
    });
  }

  retry(taskId: string): Promise<TransferJob> {
    return this.enqueue(async () => {
      const job = this.transferJobStore.retry(taskId);
      await this.pump();
      return job;
    });
  }

  cancel(taskId: string): Promise<TransferJob> {
    return this.enqueue(async () => {
      const active = this.active && this.active.job.taskId === taskId ? this.active : null;
      if (!active) return this.transferJobStore.cancel(taskId);
      await this.waitForExecutor(active);
      await this.cleanupExecutor(active, new Error('Transfer cancelled by the user'));
      if (this.active !== active) return this.transferJobStore.get(taskId) ?? active.job;
      active.job = this.transferJobStore.cancel(taskId);
      this.active = null;
      await this.pump();
      return active.job;
    });
  }

  stop(): Promise<TransferJob | null> {
    return this.enqueue(async () => {
      this.running = false;
      const active = this.active;
      if (!active) return null;
      await this.waitForExecutor(active);
      await this.cleanupExecutor(active, new Error('Transfer scheduler stopped'));
      if (this.active !== active) return null;
      if (active.job.status === JOB_STATUS.TRANSFERRING) {
        active.job = this.transferJobStore.pause(active.job.taskId);
      }
      this.active = null;
      return active.job;
    });
  }

  getActiveJob(): TransferJob | null {
    return this.active ? this.active.job : null;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.commandTail.then(operation) as Promise<T>;
    this.commandTail = result.catch(() => {});
    return result;
  }

  private async pump(): Promise<void> {
    if (!this.running || this.active) return;
    const job = this.transferJobStore.list({ includeTerminal: false }).find(
      (candidate) => candidate.direction === JOB_DIRECTION.OUTGOING && candidate.status === JOB_STATUS.QUEUED,
    );
    if (!job) return;

    let started: TransferJob;
    try {
      started = this.transferJobStore.start(job.taskId);
    } catch (error) {
      if (isMissingSourceMappingError(error)) {
        await this.pump();
        return;
      }
      this.markFailed(job.taskId, error as Error);
      await this.pump();
      return;
    }

    const active: ActiveJob = {
      job: started,
      executor: null,
      executorReady: null,
      controller: new AbortController(),
      doneResult: null,
      settled: false,
    };
    this.active = active;
    active.executorReady = this.createExecutor(active);
    try {
      await active.executorReady;
    } catch (error) {
      await this.finishActive(active, error as Error);
    }
  }

  private async createExecutor(active: ActiveJob): Promise<void> {
    const checkpoint = this.transferJobStore.getOutgoingCheckpoint(active.job.taskId);
    const executor = await this.executorFactory({
      job: active.job,
      checkpoint,
      signal: active.controller.signal,
      commitRemoteCheckpoint: (candidate: OutgoingCheckpoint, now?: number) => {
        if (this.active !== active || active.job.status !== JOB_STATUS.TRANSFERRING) {
          throw new Error('Transfer executor committed a checkpoint for an inactive job');
        }
        const committed = this.transferJobStore.advanceOutgoingCheckpoint(active.job.taskId, candidate, now);
        active.job = this.transferJobStore.get(active.job.taskId) ?? active.job;
        return committed;
      },
    });
    assertExecutor(executor);
    if (this.active !== active || active.settled) {
      await cleanupExecutor(executor, new Error('Transfer executor was superseded'));
      return;
    }
    active.executor = executor;
    Promise.resolve(executor.done).then(
      () => {
        active.doneResult = { error: null };
        return this.enqueue(() => this.finishActive(active, null)).catch(() => {});
      },
      (error: unknown) => {
        const failure = error === null ? new Error('Transfer executor failed') : (error as Error);
        active.doneResult = { error: failure };
        return this.enqueue(() => this.finishActive(active, failure)).catch(() => {});
      },
    );
  }

  private async finishActive(active: ActiveJob, error: Error | null): Promise<TransferJob> {
    if (this.active !== active || active.settled) return active.job;
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
        await this.cleanupExecutor(active, error);
        if (this.active === active && active.job.status === JOB_STATUS.TRANSFERRING) {
          active.job = this.markFailed(active.job.taskId, error);
        }
      } else {
        await this.cleanupExecutor(active, null);
      }
      return active.job;
    } finally {
      if (this.active === active) this.active = null;
      await this.pump();
    }
  }

  private async cleanupExecutor(active: ActiveJob, reason: Error | null): Promise<void> {
    if (active.cleanupPromise) return active.cleanupPromise;
    active.controller.abort(reason);
    active.cleanupPromise = cleanupExecutor(active.executor, reason);
    return active.cleanupPromise;
  }

  private async waitForExecutor(active: ActiveJob): Promise<void> {
    if (active.executorReady) {
      try {
        await active.executorReady;
      } catch (error) {
        if (this.active === active && !active.settled) throw error;
      }
    }
    if (!active.executor) throw new Error('The active transfer executor is unavailable');
  }

  private requireActive(taskId: string): ActiveJob {
    if (typeof taskId !== 'string' || !this.active || this.active.job.taskId !== taskId) {
      throw new Error('The requested transfer job is not active');
    }
    return this.active;
  }

  private markFailed(taskId: string, error: Error): TransferJob {
    const diagnosticCode = diagnosticCodeFor(error);
    try {
      return this.transferJobStore.fail(taskId, diagnosticCode, Date.now(), errorMessageFor(error));
    } catch (failureError) {
      if (/Illegal transfer job transition|not found|Invalid job transition/i.test(String((failureError as Error).message))) {
        return this.transferJobStore.get(taskId) ?? error as unknown as TransferJob;
      }
      throw failureError;
    }
  }
}

export function createDesktopTransferScheduler(options: SchedulerOptions): DesktopTransferScheduler {
  return new DesktopTransferScheduler(options);
}

function assertExecutor(executor: unknown): asserts executor is TransferExecutor {
  if (!executor || typeof executor !== 'object' || typeof (executor as TransferExecutor).done?.then !== 'function') {
    throw new TypeError('The executor factory must return an executor with a done promise');
  }
}

async function cleanupExecutor(executor: TransferExecutor | null, reason: Error | null): Promise<void> {
  if (!executor) return;
  let firstError: Error | null = null;
  if (reason !== null && typeof executor.cancel === 'function') {
    try { await executor.cancel(reason); } catch (error) { firstError = error as Error; }
  }
  for (const method of ['close', 'destroy', 'dispose'] as const) {
    const fn = (executor as unknown as Record<string, undefined | (() => Promise<unknown>)>)[method];
    if (typeof fn !== 'function') continue;
    try { await fn(); } catch (error) { if (!firstError) firstError = error as Error; }
  }
  if (firstError && reason === null) throw firstError;
}

function diagnosticCodeFor(error: Error): string {
  const err = error as Error & { diagnosticCode?: string; code?: string };
  if (err.diagnosticCode && SUPPORTED_DIAGNOSTIC_CODES.has(err.diagnosticCode)) return err.diagnosticCode;
  if (err.code && SUPPORTED_DIAGNOSTIC_CODES.has(err.code)) return err.code;
  const message = String(err.message ?? err).toLowerCase();
  if (/integrity|checksum|hash/.test(message)) return DIAGNOSTIC_CODE.INTEGRITY_CHECK_FAILED;
  if (/protocol|frame|manifest|invalid control/.test(message)) return DIAGNOSTIC_CODE.PROTOCOL_ERROR;
  if (/peer|trust|revok/.test(message)) return DIAGNOSTIC_CODE.PEER_REVOKED;
  if (/network|socket|connection|timeout|econn|offline/.test(message)) return DIAGNOSTIC_CODE.NETWORK_INTERRUPTED;
  return DIAGNOSTIC_CODE.IO_ERROR;
}

function errorMessageFor(error: Error): string {
  const message = String(error.message ?? error).trim();
  return message.slice(0, 1024) || 'Transfer executor failed';
}

function isMissingSourceMappingError(error: unknown): boolean {
  return /source file mappings are unavailable/i.test(String((error as Error)?.message ?? error));
}

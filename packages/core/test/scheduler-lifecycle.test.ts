import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DesktopTransferScheduler,
  type TransferExecutor,
  type TransferJobStoreLike,
} from '../src/transfer/scheduler.js';
import {
  DIAGNOSTIC_CODE,
  JOB_DIRECTION,
  JOB_STATUS,
  type OutgoingCheckpoint,
  type TransferJob,
} from '../src/transfer/job-store.js';

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(reason?: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>['resolve'];
  let reject!: Deferred<T>['reject'];
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function settlesPromptly<T>(promise: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('scheduler command remained blocked by executor setup')), 250);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function createJob(taskId: string): TransferJob {
  return {
    taskId,
    peerDeviceId: 'peer-device',
    direction: JOB_DIRECTION.OUTGOING,
    status: JOB_STATUS.QUEUED,
    manifest: {
      app: 'nearby-transfer',
      protocolVersion: 2,
      type: 'transfer-manifest',
      taskId,
      conflictStrategy: 'auto-rename',
      entries: [],
      totalFiles: 0,
      totalBytes: 0,
    },
    sources: [],
    sourceMappingStatus: 'available',
    recoverable: true,
    progress: { totalFiles: 0, completedFiles: 0, totalBytes: 0, transferredBytes: 0 },
    createdAt: 1,
    updatedAt: 1,
    errorMessage: null,
    diagnosticCode: null,
    files: [],
    outgoingCheckpoint: null,
  };
}

class CountingStore implements TransferJobStoreLike {
  readonly calls = { start: 0, pause: 0, cancel: 0, complete: 0, fail: 0 };

  constructor(readonly job: TransferJob) {}

  list(): TransferJob[] {
    return [this.job];
  }

  start(taskId: string): TransferJob {
    this.requireTask(taskId);
    this.calls.start += 1;
    this.job.status = JOB_STATUS.TRANSFERRING;
    return this.job;
  }

  pause(taskId: string): TransferJob {
    this.requireTask(taskId);
    this.calls.pause += 1;
    this.job.status = JOB_STATUS.PAUSED;
    return this.job;
  }

  resume(taskId: string): TransferJob {
    this.requireTask(taskId);
    this.job.status = JOB_STATUS.QUEUED;
    return this.job;
  }

  retry(taskId: string): TransferJob {
    return this.resume(taskId);
  }

  cancel(taskId: string): TransferJob {
    this.requireTask(taskId);
    if (this.job.status === JOB_STATUS.CANCELLED) throw new Error('cancelled twice');
    this.calls.cancel += 1;
    this.job.status = JOB_STATUS.CANCELLED;
    this.job.recoverable = false;
    return this.job;
  }

  complete(taskId: string): TransferJob {
    this.requireTask(taskId);
    this.calls.complete += 1;
    this.job.status = JOB_STATUS.COMPLETED;
    return this.job;
  }

  fail(taskId: string, diagnosticCode: string, _now?: number, errorMessage?: string | null): TransferJob {
    this.requireTask(taskId);
    this.calls.fail += 1;
    this.job.status = JOB_STATUS.FAILED;
    this.job.diagnosticCode = diagnosticCode;
    this.job.errorMessage = errorMessage ?? null;
    return this.job;
  }

  get(taskId: string): TransferJob | null {
    return taskId === this.job.taskId ? this.job : null;
  }

  getOutgoingCheckpoint(taskId: string): OutgoingCheckpoint | null {
    this.requireTask(taskId);
    return null;
  }

  advanceOutgoingCheckpoint(taskId: string, checkpoint: OutgoingCheckpoint): TransferJob {
    this.requireTask(taskId);
    this.job.outgoingCheckpoint = checkpoint;
    return this.job;
  }

  private requireTask(taskId: string): void {
    if (taskId !== this.job.taskId) throw new Error('job not found');
  }
}

function createTrackedExecutor(done: Promise<unknown>) {
  const cleaned = deferred<void>();
  const calls = { cancel: 0, close: 0, destroy: 0, dispose: 0 };
  const executor: TransferExecutor = {
    done,
    async cancel() { calls.cancel += 1; },
    async close() { calls.close += 1; },
    async destroy() { calls.destroy += 1; },
    async dispose() {
      calls.dispose += 1;
      cleaned.resolve();
    },
  };
  return { executor, calls, cleaned: cleaned.promise };
}

test('stop aborts pending executor setup without blocking and cleans a late executor once', async () => {
  const job = createJob('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  const store = new CountingStore(job);
  const factory = deferred<TransferExecutor>();
  const done = deferred<void>();
  const tracked = createTrackedExecutor(done.promise);
  let setupSignal: AbortSignal | null = null;
  const scheduler = new DesktopTransferScheduler({
    transferJobStore: store,
    executorFactory: ({ signal }) => {
      setupSignal = signal;
      return factory.promise;
    },
  });

  const active = await settlesPromptly(scheduler.start());
  assert.equal(active?.status, JOB_STATUS.TRANSFERRING);
  assert.equal(setupSignal?.aborted, false);

  const stopped = await settlesPromptly(scheduler.stop());
  assert.equal(stopped?.status, JOB_STATUS.PAUSED);
  assert.equal(setupSignal?.aborted, true);
  assert.equal(scheduler.getActiveJob(), null);
  assert.deepEqual(store.calls, { start: 1, pause: 1, cancel: 0, complete: 0, fail: 0 });

  factory.resolve(tracked.executor);
  await settlesPromptly(tracked.cleaned);
  assert.deepEqual(tracked.calls, { cancel: 1, close: 1, destroy: 1, dispose: 1 });

  done.resolve();
  await settlesPromptly(scheduler.kick());
  await settlesPromptly(scheduler.stop());
  assert.equal(job.status, JOB_STATUS.PAUSED);
  assert.deepEqual(store.calls, { start: 1, pause: 1, cancel: 0, complete: 0, fail: 0 });
  assert.deepEqual(tracked.calls, { cancel: 1, close: 1, destroy: 1, dispose: 1 });
});

test('cancel aborts pending setup, is idempotent, and ignores a late executor completion', async () => {
  const job = createJob('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
  const store = new CountingStore(job);
  const factory = deferred<TransferExecutor>();
  const done = deferred<void>();
  const tracked = createTrackedExecutor(done.promise);
  let setupSignal: AbortSignal | null = null;
  const scheduler = new DesktopTransferScheduler({
    transferJobStore: store,
    executorFactory: ({ signal }) => {
      setupSignal = signal;
      return factory.promise;
    },
  });

  await settlesPromptly(scheduler.start());
  const cancelled = await settlesPromptly(scheduler.cancel(job.taskId));
  assert.equal(cancelled?.status, JOB_STATUS.CANCELLED);
  assert.equal(setupSignal?.aborted, true);
  assert.equal(scheduler.getActiveJob(), null);
  assert.equal(store.calls.cancel, 1);

  const repeated = await settlesPromptly(scheduler.cancel(job.taskId));
  assert.equal(repeated?.status, JOB_STATUS.CANCELLED);
  assert.equal(store.calls.cancel, 1);

  factory.resolve(tracked.executor);
  await settlesPromptly(tracked.cleaned);
  done.resolve();
  await settlesPromptly(scheduler.kick());

  assert.equal(job.status, JOB_STATUS.CANCELLED);
  assert.equal(store.calls.complete, 0);
  assert.equal(store.calls.fail, 0);
  assert.deepEqual(tracked.calls, { cancel: 1, close: 1, destroy: 1, dispose: 1 });
  await settlesPromptly(scheduler.stop());
});

test('a factory rejection after cancellation cannot rewrite the terminal job state', async () => {
  const job = createJob('cccccccccccccccccccccccccccccccc');
  const store = new CountingStore(job);
  const factory = deferred<TransferExecutor>();
  const scheduler = new DesktopTransferScheduler({
    transferJobStore: store,
    executorFactory: () => factory.promise,
  });

  await settlesPromptly(scheduler.start());
  await settlesPromptly(scheduler.cancel(job.taskId));
  factory.reject(Object.assign(new Error('late setup failure'), { diagnosticCode: DIAGNOSTIC_CODE.IO_ERROR }));
  await settlesPromptly(scheduler.kick());

  assert.equal(job.status, JOB_STATUS.CANCELLED);
  assert.equal(store.calls.cancel, 1);
  assert.equal(store.calls.fail, 0);
  assert.equal(store.calls.complete, 0);
  await settlesPromptly(scheduler.stop());
});

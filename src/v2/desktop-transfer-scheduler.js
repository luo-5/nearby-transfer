'use strict';

const {
  DIAGNOSTIC_CODE,
  JOB_DIRECTION,
  JOB_STATUS
} = require('./transfer-job-store');

const SUPPORTED_DIAGNOSTIC_CODES = new Set(Object.values(DIAGNOSTIC_CODE));

/**
 * Coordinate persisted transfer jobs with one injected runtime executor.
 *
 * The executor contract is deliberately small so the scheduler does not know
 * how a LAN connection or a TransferStreamSession is created:
 *
 *   await executorFactory({ job, checkpoint, signal, commitRemoteCheckpoint })
 *   executor.done       Promise which resolves on success or rejects on error
 *   executor.pause()    Promise which resolves after the stream is paused
 *   executor.resume()   Promise which resolves after the stream is resumed
 *   executor.cancel()   Promise which resolves after the stream is stopped
 *
 * `close`, `destroy`, and `dispose` are also honored as best-effort cleanup
 * hooks. The factory may return the executor directly or a promise for it.
 */
function createDesktopTransferScheduler(options) {
  return new DesktopTransferScheduler(options);
}

class DesktopTransferScheduler {
  constructor({ transferJobStore, executorFactory, maxConcurrentJobs = 1 } = {}) {
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

  start() {
    return this._enqueue(async () => {
      this._running = true;
      await this._pump();
      return this.getActiveJob();
    });
  }

  kick() {
    return this._enqueue(async () => {
      await this._pump();
      return this.getActiveJob();
    });
  }

  pause(taskId) {
    return this._enqueue(async () => {
      const active = this._requireActive(taskId);
      await this._waitForExecutor(active);
      if (active.job.status !== JOB_STATUS.TRANSFERRING) return active.job;
      if (typeof active.executor.pause !== 'function') {
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

  resume(taskId) {
    return this._enqueue(async () => {
      const active = this._active && this._active.job.taskId === taskId ? this._active : null;
      if (!active) {
        const job = this.transferJobStore.resume(taskId);
        await this._pump();
        return job;
      }
      await this._waitForExecutor(active);
      if (active.job.status !== JOB_STATUS.PAUSED) return active.job;
      if (typeof active.executor.resume !== 'function') {
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

  retry(taskId) {
    return this._enqueue(async () => {
      const job = this.transferJobStore.retry(taskId);
      await this._pump();
      return job;
    });
  }

  cancel(taskId) {
    return this._enqueue(async () => {
      const active = this._active && this._active.job.taskId === taskId ? this._active : null;
      if (!active) {
        return this.transferJobStore.cancel(taskId);
      }

      await this._waitForExecutor(active);
      await this._cleanupExecutor(active, new Error('Transfer cancelled by the user'));
      if (this._active !== active) return this.transferJobStore.get(taskId);
      active.job = this.transferJobStore.cancel(taskId);
      this._active = null;
      await this._pump();
      return active.job;
    });
  }

  stop() {
    return this._enqueue(async () => {
      this._running = false;
      const active = this._active;
      if (!active) return null;

      await this._waitForExecutor(active);
      await this._cleanupExecutor(active, new Error('Transfer scheduler stopped'));
      if (this._active !== active) return null;
      if (active.job.status === JOB_STATUS.TRANSFERRING) {
        active.job = this.transferJobStore.pause(taskIdOf(active));
      }
      this._active = null;
      return active.job;
    });
  }

  getActiveJob() {
    return this._active ? this._active.job : null;
  }

  _enqueue(operation) {
    const result = this._commandTail.then(operation);
    this._commandTail = result.catch(() => {});
    return result;
  }

  async _pump() {
    if (!this._running || this._active) return;
    const job = this.transferJobStore.list({ includeTerminal: false })
      .find((candidate) => candidate.direction === JOB_DIRECTION.OUTGOING &&
        candidate.status === JOB_STATUS.QUEUED && candidate.recoverable !== false);
    if (!job) return;

    let started;
    try {
      started = this.transferJobStore.start(job.taskId);
    } catch (error) {
      if (isMissingSourceMappingError(error)) {
        await this._pump();
        return;
      }
      this._markFailed(job.taskId, error);
      await this._pump();
      return;
    }

    const active = {
      job: started,
      executor: null,
      executorReady: null,
      controller: new AbortController(),
      doneResult: null,
      settled: false
    };
    this._active = active;
    active.executorReady = this._createExecutor(active);
    try {
      await active.executorReady;
    } catch (error) {
      await this._finishActive(active, error);
    }
  }

  async _createExecutor(active) {
    try {
      const checkpoint = this.transferJobStore.getOutgoingCheckpoint(active.job.taskId);
      const executor = await this.executorFactory({
        job: active.job,
        checkpoint,
        signal: active.controller.signal,
        commitRemoteCheckpoint: (candidate, now) => {
          if (this._active !== active || active.job.status !== JOB_STATUS.TRANSFERRING) {
            throw new Error('Transfer executor committed a checkpoint for an inactive job');
          }
          const committed = this.transferJobStore.advanceOutgoingCheckpoint(
            active.job.taskId,
            candidate,
            now
          );
          active.job = this.transferJobStore.get(active.job.taskId);
          return committed;
        }
      });
      assertExecutor(executor);
      if (this._active !== active || active.settled) {
        await cleanupExecutor(executor, new Error('Transfer executor was superseded'));
        return;
      }
      active.executor = executor;
      Promise.resolve(executor.done).then(
        () => {
          active.doneResult = { error: null };
          return this._enqueue(() => this._finishActive(active, null)).catch(() => {});
        },
        (error) => {
          const failure = error === null ? new Error('Transfer executor failed') : error;
          active.doneResult = { error: failure };
          return this._enqueue(() => this._finishActive(active, failure)).catch(() => {});
        }
      );
    } catch (error) {
      throw error;
    }
  }

  async _finishActive(active, error) {
    if (this._active !== active || active.settled) return active.job;
    active.settled = true;
    try {
      if (error === null) {
        try {
          active.job = this.transferJobStore.complete(active.job.taskId);
        } catch (completionError) {
          error = completionError;
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

  async _cleanupExecutor(active, reason) {
    if (active.cleanupPromise) return active.cleanupPromise;
    active.controller.abort(reason);
    active.cleanupPromise = cleanupExecutor(active.executor, reason);
    return active.cleanupPromise;
  }

  async _waitForExecutor(active) {
    if (active.executorReady) {
      try {
        await active.executorReady;
      } catch (error) {
        if (this._active === active && !active.settled) throw error;
      }
    }
    if (!active.executor) throw new Error('The active transfer executor is unavailable');
  }

  _requireActive(taskId) {
    if (typeof taskId !== 'string' || !this._active || this._active.job.taskId !== taskId) {
      throw new Error('The requested transfer job is not active');
    }
    return this._active;
  }

  _markFailed(taskId, error) {
    const diagnosticCode = diagnosticCodeFor(error);
    try {
      return this.transferJobStore.fail(taskId, diagnosticCode, Date.now(), errorMessageFor(error));
    } catch (failureError) {
      if (/Illegal transfer job transition|not found/i.test(String(failureError.message))) {
        return this.transferJobStore.get(taskId);
      }
      throw failureError;
    }
  }
}

function assertExecutor(executor) {
  if (!executor || typeof executor !== 'object' || typeof executor.done?.then !== 'function') {
    throw new TypeError('The executor factory must return an executor with a done promise');
  }
}

async function cleanupExecutor(executor, reason) {
  if (!executor) return;
  let firstError = null;
  if (reason !== null && typeof executor.cancel === 'function') {
    try {
      await executor.cancel(reason);
    } catch (error) {
      firstError = error;
    }
  }
  for (const method of ['close', 'destroy', 'dispose']) {
    if (typeof executor[method] !== 'function') continue;
    try {
      await executor[method]();
    } catch (error) {
      if (!firstError) firstError = error;
    }
  }
  if (firstError && reason === null) throw firstError;
}

function diagnosticCodeFor(error) {
  if (error && SUPPORTED_DIAGNOSTIC_CODES.has(error.diagnosticCode)) return error.diagnosticCode;
  if (error && SUPPORTED_DIAGNOSTIC_CODES.has(error.code)) return error.code;
  const message = String(error && error.message ? error.message : error).toLowerCase();
  if (/integrity|checksum|hash/.test(message)) return DIAGNOSTIC_CODE.INTEGRITY_CHECK_FAILED;
  if (/protocol|frame|manifest|invalid control/.test(message)) return DIAGNOSTIC_CODE.PROTOCOL_ERROR;
  if (/peer|trust|revok/.test(message)) return DIAGNOSTIC_CODE.PEER_REVOKED;
  if (/network|socket|connection|timeout|econn|offline/.test(message)) return DIAGNOSTIC_CODE.NETWORK_INTERRUPTED;
  return DIAGNOSTIC_CODE.IO_ERROR;
}

function errorMessageFor(error) {
  const message = String(error && error.message ? error.message : error).trim();
  return message.slice(0, 1024) || 'Transfer executor failed';
}

function isMissingSourceMappingError(error) {
  return /source file mappings are unavailable/i.test(String(error && error.message ? error.message : error));
}

function taskIdOf(active) {
  return active.job.taskId;
}

module.exports = {
  DesktopTransferScheduler,
  createDesktopTransferScheduler
};

'use strict';

function createDesktopTransferJobApi({ transferJobStore }) {
  if (!transferJobStore || typeof transferJobStore.list !== 'function') {
    throw new TypeError('A transfer job store is required');
  }

  return Object.freeze({
    listJobs: () => transferJobStore.list({ includeTerminal: true }).map(toPublicTransferJob),
    pause: (taskId) => toPublicTransferJob(transferJobStore.pause(taskId)),
    resume: (taskId) => toPublicTransferJob(transferJobStore.resume(taskId)),
    retry: (taskId) => toPublicTransferJob(transferJobStore.retry(taskId)),
    cancel: (taskId) => {
      const job = transferJobStore.cancel(taskId);
      return job ? toPublicTransferJob(job) : null;
    },

    // Transport-only operations: never registered as renderer IPC handlers.
    queueOutgoing: (request) => transferJobStore.queueOutgoing(request),
    receivePending: (request) => transferJobStore.receivePending(request),
    approveIncoming: (taskId) => transferJobStore.approveIncoming(taskId),
    start: (taskId) => transferJobStore.start(taskId),
    recordFileProgress: (taskId, relativePath, transferredBytes) =>
      transferJobStore.recordFileProgress(taskId, relativePath, transferredBytes),
    complete: (taskId) => transferJobStore.complete(taskId),
    fail: (taskId, diagnosticCode) => transferJobStore.fail(taskId, diagnosticCode)
  });
}

function registerTransferJobIpcHandlers(ipcMain, api) {
  if (!ipcMain || typeof ipcMain.handle !== 'function') {
    throw new TypeError('ipcMain.handle is required');
  }
  if (!api) {
    throw new TypeError('A desktop transfer job API is required');
  }
  ipcMain.handle('v2:list-transfer-jobs', () => api.listJobs());
  ipcMain.handle('v2:pause-transfer-job', (_event, taskId) => api.pause(taskId));
  ipcMain.handle('v2:resume-transfer-job', (_event, taskId) => api.resume(taskId));
  ipcMain.handle('v2:retry-transfer-job', (_event, taskId) => api.retry(taskId));
  ipcMain.handle('v2:cancel-transfer-job', (_event, taskId) => api.cancel(taskId));
}

function toPublicTransferJob(job) {
  if (!job || typeof job !== 'object') {
    throw new TypeError('A transfer job is required');
  }
  return {
    taskId: job.taskId,
    peerDeviceId: job.peerDeviceId,
    direction: job.direction,
    status: job.status,
    manifest: {
      taskId: job.manifest.taskId,
      conflictStrategy: job.manifest.conflictStrategy,
      entries: job.manifest.entries,
      totalFiles: job.manifest.totalFiles,
      totalBytes: job.manifest.totalBytes
    },
    progress: job.progress,
    diagnosticCode: job.diagnosticCode,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt
  };
}

module.exports = {
  createDesktopTransferJobApi,
  registerTransferJobIpcHandlers,
  toPublicTransferJob
};
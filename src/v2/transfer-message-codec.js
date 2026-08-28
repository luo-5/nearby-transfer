'use strict';

/**
 * Strangler fig adapter — re-exports transfer message codec functions from @luo-5/core.
 * The original implementation has been replaced by the TypeScript core library.
 */

const core = require('@luo-5/core');

module.exports = {
  COMPLETION_DIAGNOSTICS: core.COMPLETION_DIAGNOSTICS,
  DECISIONS: core.DECISIONS,
  MAX_CLOCK_SKEW_MS: core.MAX_CLOCK_SKEW_MS,
  MAX_CONTROL_MESSAGE_BYTES: core.MAX_CONTROL_MESSAGE_BYTES,
  MAX_MESSAGE_TTL_MS: core.MAX_MESSAGE_TTL_MS,
  MAX_RESUME_ENTRIES: core.MAX_RESUME_ENTRIES,
  MAX_TRANSFER_MESSAGE_BYTES: core.MAX_TRANSFER_MESSAGE_BYTES,
  SESSION_ID_BYTES: core.SESSION_ID_BYTES,
  TYPE_TRANSFER_COMPLETE: core.TYPE_TRANSFER_COMPLETE,
  TYPE_TRANSFER_DECISION: core.TYPE_TRANSFER_DECISION,
  TYPE_TRANSFER_MANIFEST: core.TYPE_TRANSFER_MANIFEST,
  TYPE_TRANSFER_PROGRESS: core.TYPE_TRANSFER_PROGRESS,
  TYPE_TRANSFER_RESUME: core.TYPE_TRANSFER_RESUME,
  advanceTransferControlCheckpoint: core.advanceTransferControlCheckpoint,
  assertValidSessionId: core.assertValidSessionId,
  decodeTransferMessage: core.decodeTransferMessage,
  encodeTransferMessage: core.encodeTransferMessage,
  transferMessageSigningPayload: core.transferMessageSigningPayload,
  validateTransferMessage: core.validateTransferMessage,
};

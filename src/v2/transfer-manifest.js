'use strict';

/**
 * Strangler fig adapter — re-exports transfer manifest functions from @luo-5/core.
 * The original implementation has been replaced by the TypeScript core library.
 */

const {
  CONFLICT_STRATEGY_AUTO_RENAME,
  MAX_FILE_SIZE_BYTES,
  MAX_MANIFEST_ENTRIES,
  MAX_RELATIVE_PATH_BYTES,
  MAX_TOTAL_SIZE_BYTES,
  MAX_TRANSFER_FILES,
  PERSISTENCE_FORMAT_VERSION,
  assertValidRelativePath,
  assertValidTaskId,
  createPersistedTransferManifest,
  createTaskId,
  createTransferManifest,
  normalizeTransferManifest,
  parsePersistedTransferManifest,
  serializeTransferManifest,
} = require('@luo-5/core');

module.exports = {
  CONFLICT_STRATEGY_AUTO_RENAME,
  MAX_FILE_SIZE_BYTES,
  MAX_MANIFEST_ENTRIES,
  MAX_RELATIVE_PATH_BYTES,
  MAX_TOTAL_SIZE_BYTES,
  MAX_TRANSFER_FILES,
  PERSISTENCE_FORMAT_VERSION,
  assertValidRelativePath,
  assertValidTaskId,
  createPersistedTransferManifest,
  createTaskId,
  createTransferManifest,
  normalizeTransferManifest,
  parsePersistedTransferManifest,
  serializeTransferManifest,
};

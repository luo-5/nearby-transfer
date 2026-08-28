'use strict';

/**
 * Strangler fig adapter — re-exports transfer source manifest functions from @luo-5/core.
 * The original implementation has been replaced by the TypeScript core library.
 */

const { MAX_SOURCE_ROOTS, buildTransferSourceManifest } = require('@luo-5/core');

module.exports = {
  MAX_SOURCE_ROOTS,
  buildTransferSourceManifest,
};

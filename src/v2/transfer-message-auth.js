'use strict';

/**
 * Strangler fig adapter — re-exports transfer message auth functions from @luo-5/core.
 * The original implementation has been replaced by the TypeScript core library.
 */

const { signTransferMessage, verifyTransferMessage } = require('../vendor/luo5-core/index.cjs');

module.exports = {
  signTransferMessage,
  verifyTransferMessage,
};

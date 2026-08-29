'use strict';

/**
 * Strangler fig adapter — re-exports pairing message codec functions from @luo-5/core.
 * The original implementation has been replaced by the TypeScript core library.
 */

const {
  MAX_CONTROL_PAYLOAD_BYTES,
  encodeControlMessage,
  decodeControlMessage,
  validateControlMessage,
} = require('../vendor/luo5-core/index.cjs');

module.exports = {
  MAX_CONTROL_PAYLOAD_BYTES,
  encodeControlMessage,
  decodeControlMessage,
  validateControlMessage,
};
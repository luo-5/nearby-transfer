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
} = require('@luo-5/core');

module.exports = {
  MAX_CONTROL_PAYLOAD_BYTES,
  encodeControlMessage,
  decodeControlMessage,
  validateControlMessage,
};
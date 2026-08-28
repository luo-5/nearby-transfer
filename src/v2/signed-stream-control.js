'use strict';

/**
 * Strangler fig adapter — re-exports signed stream control functions from @luo-5/core.
 * The original implementation has been replaced by the TypeScript core library.
 */

const { MAX_ENCODED_BYTES, createSignedStreamControlCodec } = require('@luo-5/core');

module.exports = {
  MAX_ENCODED_BYTES,
  createSignedStreamControlCodec,
};

'use strict';

/**
 * Strangler fig adapter — re-exports signed stream control functions from @luo-5/core.
 * The original implementation has been replaced by the TypeScript core library.
 */

const { MAX_ENCODED_BYTES, createSignedStreamControlCodec } = require('../vendor/luo5-core/index.cjs');

module.exports = {
  MAX_ENCODED_BYTES,
  createSignedStreamControlCodec,
};

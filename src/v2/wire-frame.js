'use strict';

/**
 * Strangler fig adapter — re-exports wire frame functions from @luo-5/core.
 * The original implementation has been replaced by the TypeScript core library.
 */

const {
  FRAME_LENGTH_BYTES,
  HEADER_LENGTH_BYTES,
  FRAME_PREFIX_BYTES,
  MAX_FRAME_SIZE,
  MAX_HEADER_SIZE,
  MAX_BUFFERED_BYTES,
  encodeWireFrame,
  decodeWireFrame,
  WireFrameDecoder,
} = require('../vendor/luo5-core/index.cjs');

module.exports = {
  FRAME_LENGTH_BYTES,
  HEADER_LENGTH_BYTES,
  FRAME_PREFIX_BYTES,
  MAX_FRAME_SIZE,
  MAX_HEADER_SIZE,
  MAX_BUFFERED_BYTES,
  encodeWireFrame,
  decodeWireFrame,
  WireFrameDecoder,
};

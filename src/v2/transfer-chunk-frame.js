'use strict';

/**
 * Strangler fig adapter — re-exports transfer chunk frame functions from @luo-5/core.
 * The original implementation has been replaced by the TypeScript core library.
 */

const core = require('../vendor/luo5-core/index.cjs');

module.exports = {
  FLAGS: core.FLAGS,
  HEADER_BYTES: core.HEADER_BYTES,
  MAGIC: core.MAGIC,
  MAX_FRAME_BYTES: core.MAX_FRAME_BYTES,
  TASK_ID_BYTES: core.TASK_ID_CHAR_LENGTH ?? 22,
  VERSION: core.VERSION,
  TransferChunkFrameParser: core.TransferChunkFrameParser,
  decodeFrame: core.decodeFrame,
  encodeFrame: core.encodeFrame,
};

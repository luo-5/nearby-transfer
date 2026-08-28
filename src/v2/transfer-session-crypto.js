'use strict';

/**
 * Strangler fig adapter — re-exports transfer session crypto functions from @luo-5/core.
 * The original implementation has been replaced by the TypeScript core library.
 */

const core = require('@luo-5/core');

module.exports = {
  AUTH_TAG_BYTES: core.AUTH_TAG_BYTES,
  CONTEXT: core.CONTEXT,
  KEY_BYTES: core.KEY_BYTES,
  MAX_CHUNK_BYTES: core.MAX_CHUNK_BYTES,
  MAX_SEQUENCE: core.MAX_SEQUENCE,
  NONCE_BYTES: core.NONCE_BYTES,
  buildChunkAad: core.buildChunkAad,
  decryptChunk: core.decryptChunk,
  deriveSessionKey: core.deriveSessionKey,
  encryptChunk: core.encryptChunk,
};

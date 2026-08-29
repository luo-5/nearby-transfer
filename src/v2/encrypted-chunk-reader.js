'use strict';

const core = require('../vendor/luo5-core/index.cjs');
const { encryptChunk } = require('./transfer-session-crypto');

function createEncryptedChunkReader(input) {
  return core.createEncryptedChunkReader({
    ...input,
    encryptChunk: input && input.encryptChunk ? input.encryptChunk : encryptChunk,
  });
}

module.exports = {
  DEFAULT_CHUNK_SIZE: core.DEFAULT_CHUNK_SIZE,
  createEncryptedChunkReader,
};

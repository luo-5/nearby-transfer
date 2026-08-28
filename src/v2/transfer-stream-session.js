'use strict';

const core = require('@luo-5/core');

module.exports = {
  CONTROL_TYPES: core.CONTROL_TYPES,
  FRAME_KIND_CHUNK: core.FRAME_KIND_CHUNK,
  FRAME_KIND_CONTROL: core.FRAME_KIND_CONTROL,
  FRAME_KIND_PROGRESS: core.FRAME_KIND_PROGRESS,
  MUX_MAGIC: Buffer.from(core.MUX_MAGIC),
  MUX_PREFIX_BYTES: core.MUX_PREFIX_BYTES,
  MUX_VERSION: core.MUX_VERSION,
  StreamEnvelopeDecoder: core.StreamEnvelopeDecoder,
  createTransferStreamSession: core.createTransferStreamSession,
  encodeStreamEnvelope: core.encodeStreamEnvelope,
};

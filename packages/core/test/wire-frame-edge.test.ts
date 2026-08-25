import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import {
  encodeWireFrame,
  decodeWireFrame,
  WireFrameDecoder,
  MAX_FRAME_SIZE,
  MAX_HEADER_SIZE,
  HEADER_LENGTH_BYTES,
  FRAME_LENGTH_BYTES,
} from '../src/transfer/wire-frame.js';

describe('wire-frame edge tests', () => {
  const header = { app: 'nearby-transfer', protocolVersion: 2, type: 'transfer-manifest' };
  const payload = Buffer.from('sample payload');

  it('rejects truncated wire frames on single decode', () => {
    const encoded = encodeWireFrame({ header, payload });
    // Truncate before header length
    assert.throws(() => decodeWireFrame(encoded.subarray(0, 3)), /truncated/i);
    // Truncate inside header
    assert.throws(() => decodeWireFrame(encoded.subarray(0, 20)), /truncated/i);
    // Truncate inside payload
    assert.throws(() => decodeWireFrame(encoded.subarray(0, encoded.length - 2)), /truncated/i);
  });

  it('rejects wire frames with trailing data on single decode', () => {
    const encoded = encodeWireFrame({ header, payload });
    const withTrailing = Buffer.concat([encoded, Buffer.from('extra bytes')]);
    assert.throws(() => decodeWireFrame(withTrailing), /trailing bytes|integer|between/i);
  });

  it('rejects frame length claiming less than header length bytes', () => {
    const malformed = Buffer.alloc(10);
    malformed.writeUInt32BE(1, 0); // frameLength = 1 (< HEADER_LENGTH_BYTES 2)
    assert.throws(() => decodeWireFrame(malformed), /between|integer/i);
  });

  it('handles fragmented delivery cleanly in WireFrameDecoder', () => {
    const frame1 = encodeWireFrame({ header, payload: Buffer.from('frame1') });
    const frame2 = encodeWireFrame({ header, payload: Buffer.from('frame2') });
    const combined = Buffer.concat([frame1, frame2]);

    const decoder = new WireFrameDecoder();
    // Feed in 1-byte increments
    const decodedFrames = [];
    for (let i = 0; i < combined.length; i++) {
      const frames = decoder.push(combined.subarray(i, i + 1));
      decodedFrames.push(...frames);
    }
    decoder.finish();

    assert.equal(decodedFrames.length, 2);
    assert.equal(decodedFrames[0]!.payload.toString('utf8'), 'frame1');
    assert.equal(decodedFrames[1]!.payload.toString('utf8'), 'frame2');
  });

  it('throws on finish if incomplete bytes remain in WireFrameDecoder', () => {
    const decoder = new WireFrameDecoder();
    decoder.push(Buffer.from([0x00, 0x00, 0x00, 0x50])); // 4 bytes of partial frame
    assert.throws(() => decoder.finish(), /truncated/i);
  });
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Buffer } from 'node:buffer';
import { encodeWireFrame, decodeWireFrame, WireFrameDecoder } from '../../src/transfer/wire-frame.js';

describe('fuzz-wire-frame', () => {
  it('passes 1,000 randomized wire frame encode -> decode -> compare trials', () => {
    const TRIALS = 1000;
    const types = ['transfer-manifest', 'transfer-decision', 'transfer-resume', 'transfer-progress'];

    for (let i = 0; i < TRIALS; i++) {
      const header = {
        app: 'nearby-transfer',
        protocolVersion: 2,
        type: types[i % types.length]!,
      };

      const payloadLen = Math.floor(Math.random() * 4096);
      const payload = crypto.randomBytes(payloadLen);

      const encoded = encodeWireFrame({ header, payload });
      const decoded = decodeWireFrame(encoded);

      assert.deepEqual(decoded.header, header, `Header mismatch on trial ${i}`);
      assert.ok(decoded.payload.equals(payload), `Payload mismatch on trial ${i}`);
    }
  });

  it('passes 1,000 randomized chunk-fragmentation stream decoding trials', () => {
    const TRIALS = 1000;
    for (let i = 0; i < TRIALS; i++) {
      const header = { app: 'nearby-transfer', protocolVersion: 2, type: 'transfer-manifest' };
      const payload = crypto.randomBytes(Math.floor(Math.random() * 2048));
      const encoded = encodeWireFrame({ header, payload });

      const decoder = new WireFrameDecoder();
      let cursor = 0;
      const decodedList = [];

      while (cursor < encoded.length) {
        const chunkSize = Math.min(encoded.length - cursor, Math.floor(Math.random() * 128) + 1);
        const slice = encoded.subarray(cursor, cursor + chunkSize);
        cursor += chunkSize;
        const frames = decoder.push(slice);
        decodedList.push(...frames);
      }
      decoder.finish();

      assert.equal(decodedList.length, 1);
      assert.deepEqual(decodedList[0]!.header, header);
      assert.ok(decodedList[0]!.payload.equals(payload));
    }
  });
});

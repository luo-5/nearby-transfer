'use strict';

const assert = require('assert');
const {
  FRAME_LENGTH_BYTES,
  HEADER_LENGTH_BYTES,
  MAX_FRAME_SIZE,
  MAX_HEADER_SIZE,
  MAX_BUFFERED_BYTES,
  encodeWireFrame,
  decodeWireFrame,
  WireFrameDecoder
} = require('../src/v2/wire-frame');

const HEADER = Object.freeze({
  app: 'nearby-transfer',
  protocolVersion: 2,
  type: 'transfer-chunk'
});

function testRoundTripAndCanonicalHeader() {
  const payload = Buffer.from([0, 255, 1, 2, 3]);
  const encoded = encodeWireFrame({ header: HEADER, payload });
  assert.strictEqual(encoded.readUInt32BE(0), HEADER_LENGTH_BYTES + Buffer.byteLength(JSON.stringify(HEADER)) + payload.length);

  const decoded = decodeWireFrame(encoded);
  assert.deepStrictEqual(decoded.header, HEADER);
  assert.deepStrictEqual(decoded.payload, payload);

  const empty = decodeWireFrame(encodeWireFrame({
    header: { type: 'pairing-offer', protocolVersion: 2, app: 'nearby-transfer' }
  }));
  assert.strictEqual(empty.payload.length, 0);
  assert.deepStrictEqual(empty.header, {
    app: 'nearby-transfer',
    protocolVersion: 2,
    type: 'pairing-offer'
  });
}

function testTransferControlMessageTypes() {
  for (const type of [
    'transfer-manifest',
    'transfer-decision',
    'transfer-resume',
    'transfer-progress',
    'transfer-complete'
  ]) {
    const decoded = decodeWireFrame(encodeWireFrame({
      header: { app: 'nearby-transfer', protocolVersion: 2, type },
      payload: Buffer.from(type)
    }));
    assert.strictEqual(decoded.header.type, type);
    assert.strictEqual(decoded.payload.toString(), type);
  }
}

function testIncrementalAndStickyPackets() {
  const first = encodeWireFrame({ header: HEADER, payload: Buffer.from('first') });
  const second = encodeWireFrame({
    header: { app: 'nearby-transfer', protocolVersion: 2, type: 'transfer-complete' },
    payload: Buffer.from('second')
  });
  const decoder = new WireFrameDecoder();

  assert.deepStrictEqual(decoder.push(first.subarray(0, 3)), []);
  assert.deepStrictEqual(decoder.push(first.subarray(3, 11)), []);
  const frames = decoder.push(Buffer.concat([first.subarray(11), second]));
  assert.strictEqual(frames.length, 2);
  assert.strictEqual(frames[0].payload.toString(), 'first');
  assert.strictEqual(frames[1].payload.toString(), 'second');
  assert.strictEqual(decoder.bufferedBytes, 0);
  assert.deepStrictEqual(decoder.finish(), []);
}

function testMalformedLengthsAndTruncation() {
  const tooLarge = Buffer.alloc(FRAME_LENGTH_BYTES);
  tooLarge.writeUInt32BE(MAX_FRAME_SIZE + 1, 0);
  assert.throws(() => new WireFrameDecoder().push(tooLarge), /integer from/);

  const tooShort = Buffer.alloc(FRAME_LENGTH_BYTES);
  tooShort.writeUInt32BE(HEADER_LENGTH_BYTES - 1, 0);
  assert.throws(() => new WireFrameDecoder().push(tooShort), /integer from/);

  const valid = encodeWireFrame({ header: HEADER, payload: Buffer.from('payload') });
  const partial = new WireFrameDecoder();
  partial.push(valid.subarray(0, valid.length - 1));
  assert.throws(() => partial.finish(), /Truncated/);

  const inconsistentHeaderLength = Buffer.from(valid);
  inconsistentHeaderLength.writeUInt16BE(inconsistentHeaderLength.readUInt32BE(0), FRAME_LENGTH_BYTES);
  assert.throws(() => decodeWireFrame(inconsistentHeaderLength), /exceeds/);
}

function testStrictHeaderValidation() {
  assert.throws(() => encodeWireFrame({ header: { ...HEADER, extra: true } }), /unknown field/);
  assert.throws(() => encodeWireFrame({ header: { ...HEADER, type: 'made-up-message' } }), /supported/);
  assert.throws(() => encodeWireFrame({ header: { ...HEADER, protocolVersion: '2' } }), /integer/);
  assert.throws(() => encodeWireFrame({ header: { ...HEADER, protocolVersion: 2.5 } }), /integer/);
  assert.throws(() => encodeWireFrame({ header: { ...HEADER, app: 'other' } }), /app/);
  assert.throws(() => encodeWireFrame({ header: HEADER, payload: 'bytes' }), /Buffer or Uint8Array/);
}

function testRejectsNoncanonicalAndInvalidHeaderBytes() {
  const noncanonicalHeader = Buffer.from('{"type":"transfer-chunk","app":"nearby-transfer","protocolVersion":2}', 'utf8');
  const encoded = makeFrame(noncanonicalHeader, Buffer.alloc(0));
  assert.throws(() => decodeWireFrame(encoded), /canonical/);

  const unknownFieldHeader = Buffer.from('{"app":"nearby-transfer","extra":true,"protocolVersion":2,"type":"transfer-chunk"}', 'utf8');
  assert.throws(() => decodeWireFrame(makeFrame(unknownFieldHeader, Buffer.alloc(0))), /unknown field/);

  const invalidUtf8 = Buffer.from([0xc3, 0x28]);
  assert.throws(() => decodeWireFrame(makeFrame(invalidUtf8, Buffer.alloc(0))), /valid UTF-8/);

  const bomHeader = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify(HEADER))]);
  assert.throws(() => decodeWireFrame(makeFrame(bomHeader, Buffer.alloc(0))), /byte-order mark/);
}

function testHeaderAndBufferLimits() {
  const oversizedHeader = Buffer.alloc(MAX_HEADER_SIZE + 1, 0x61);
  assert.throws(() => decodeWireFrame(makeFrame(oversizedHeader, Buffer.alloc(0))), /header length/);

  const decoder = new WireFrameDecoder();
  assert.throws(() => decoder.push(Buffer.alloc(MAX_BUFFERED_BYTES + 1)), /buffer exceeds/);
}

function makeFrame(header, payload) {
  const bodyLength = HEADER_LENGTH_BYTES + header.length + payload.length;
  assert.ok(bodyLength <= MAX_FRAME_SIZE);
  const output = Buffer.alloc(FRAME_LENGTH_BYTES + bodyLength);
  output.writeUInt32BE(bodyLength, 0);
  output.writeUInt16BE(header.length, FRAME_LENGTH_BYTES);
  header.copy(output, FRAME_LENGTH_BYTES + HEADER_LENGTH_BYTES);
  payload.copy(output, FRAME_LENGTH_BYTES + HEADER_LENGTH_BYTES + header.length);
  return output;
}

testRoundTripAndCanonicalHeader();
testTransferControlMessageTypes();
testIncrementalAndStickyPackets();
testMalformedLengthsAndTruncation();
testStrictHeaderValidation();
testRejectsNoncanonicalAndInvalidHeaderBytes();
testHeaderAndBufferLimits();
console.log('wire frame smoke tests passed');
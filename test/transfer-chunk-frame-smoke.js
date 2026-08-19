'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  FLAGS,
  HEADER_BYTES,
  MAGIC,
  MAX_FRAME_BYTES,
  TASK_ID_BYTES,
  VERSION,
  TransferChunkFrameParser,
  decodeFrame,
  encodeFrame
} = require('../src/v2/transfer-chunk-frame');
const { MAX_CHUNK_BYTES } = require('../src/v2/transfer-session-crypto');

const fixture = JSON.parse(fs.readFileSync(
  path.join(__dirname, 'fixtures', 'protocol-v2-transfer-chunks.json'),
  'utf8'
));
const vector = fixture.vector;
const vectorInput = () => ({
  taskId: vector.taskId,
  relativePath: vector.relativePath,
  offset: vector.offset,
  sequence: vector.sequence,
  plainLength: vector.plainLength,
  nonce: Buffer.from(vector.nonceHex, 'hex'),
  authTag: Buffer.from(vector.authTagHex, 'hex'),
  ciphertext: Buffer.from(vector.ciphertextHex, 'hex')
});
const vectorBytes = Buffer.from(vector.frameHex, 'hex');

assert.strictEqual(MAGIC.toString('ascii'), fixture.format.magicAscii);
assert.strictEqual(VERSION, fixture.format.version);
assert.strictEqual(FLAGS, 0);
assert.strictEqual(HEADER_BYTES, fixture.format.headerBytes);
assert.strictEqual(TASK_ID_BYTES, 22);
assert.strictEqual(MAX_FRAME_BYTES, fixture.format.maxFrameBytes);
assert.strictEqual(encodeFrame(vectorInput()).toString('hex'), vector.frameHex);
assertFrameEquals(decodeFrame(vectorBytes), vectorInput());

const decodedFromUint8 = decodeFrame(new Uint8Array(vectorBytes));
assertFrameEquals(decodedFromUint8, vectorInput());
assert.deepStrictEqual(Object.keys(decodedFromUint8), [
  'taskId', 'relativePath', 'offset', 'sequence', 'plainLength', 'nonce', 'authTag', 'ciphertext'
]);
assert.strictEqual(Object.hasOwn(decodedFromUint8, 'key'), false);
assert.strictEqual(Object.hasOwn(decodedFromUint8, 'plaintext'), false);

const mutableWire = Buffer.from(vectorBytes);
const detached = decodeFrame(mutableWire);
mutableWire.fill(0);
assert.strictEqual(detached.nonce.toString('hex'), vector.nonceHex);
assert.strictEqual(detached.authTag.toString('hex'), vector.authTagHex);
assert.strictEqual(detached.ciphertext.toString('hex'), vector.ciphertextHex);

const emptyInput = {
  taskId: vector.taskId,
  relativePath: 'empty.txt',
  offset: 0,
  sequence: 0,
  plainLength: 0,
  nonce: Buffer.alloc(12, 1),
  authTag: Buffer.alloc(16, 2),
  ciphertext: Buffer.alloc(0)
};
assertFrameEquals(decodeFrame(encodeFrame(emptyInput)), emptyInput);

const parser = new TransferChunkFrameParser();
const streamed = [];
for (const byte of vectorBytes) {
  streamed.push(...parser.push(Buffer.of(byte)));
}
parser.finish();
assert.strictEqual(streamed.length, 1);
assertFrameEquals(streamed[0], vectorInput());

const secondBytes = encodeFrame(emptyInput);
const combinedParser = new TransferChunkFrameParser();
const combined = Buffer.concat([vectorBytes, secondBytes]);
const combinedFrames = [
  ...combinedParser.push(combined.subarray(0, 17)),
  ...combinedParser.push(combined.subarray(17, vectorBytes.length + 9)),
  ...combinedParser.push(combined.subarray(vectorBytes.length + 9))
];
combinedParser.finish();
assert.strictEqual(combinedFrames.length, 2);
assertFrameEquals(combinedFrames[0], vectorInput());
assertFrameEquals(combinedFrames[1], emptyInput);
assert.throws(() => combinedParser.push(Buffer.alloc(0)), /already finished/);
assert.throws(() => combinedParser.finish(), /already finished/);

const truncatedParser = new TransferChunkFrameParser();
assert.deepStrictEqual(truncatedParser.push(vectorBytes.subarray(0, vectorBytes.length - 1)), []);
assert.throws(() => truncatedParser.finish(), /truncated frame/);

assertRejectsWire(vectorBytes.subarray(0, HEADER_BYTES - 1), /header is truncated/);
assertRejectsWire(vectorBytes.subarray(0, vectorBytes.length - 1), /is truncated/);
assertRejectsWire(Buffer.concat([vectorBytes, Buffer.of(0)]), /trailing bytes/);
mutateAndReject(0, 0, /magic/);
mutateAndReject(8, VERSION + 1, /version/);
mutateAndReject(9, 1, /flags/);
mutateUInt16AndReject(10, HEADER_BYTES + 1, /header length/);
mutateUInt32AndReject(12, vectorBytes.length - 1, /frame length/);
mutateUInt16AndReject(16, TASK_ID_BYTES - 1, /task ID length/);
mutateUInt16AndReject(18, 0, /path length/);
mutateUInt16AndReject(18, 4097, /path length/);
mutateUInt32AndReject(36, vector.plainLength - 1, /ciphertext length/);
mutateUInt32AndReject(40, MAX_CHUNK_BYTES + 1, /maximum length/);
mutateAndReject(44, 11, /nonce/);
mutateAndReject(45, 15, /authentication tag/);
mutateUInt16AndReject(46, 1, /reserved/);

const offsetOverflow = Buffer.from(vectorBytes);
offsetOverflow.writeBigUInt64BE(BigInt(Number.MAX_SAFE_INTEGER) + 1n, 20);
assertRejectsWire(offsetOverflow, /safe integer/);
const sequenceOverflow = Buffer.from(vectorBytes);
sequenceOverflow.writeBigUInt64BE(0xffffffffffffffffn, 28);
assertRejectsWire(sequenceOverflow, /safe integer/);

const invalidUtf8Path = Buffer.from(vectorBytes);
const pathStart = HEADER_BYTES + TASK_ID_BYTES;
invalidUtf8Path[pathStart + Buffer.byteLength('docs/', 'utf8')] = 0xc0;
assertRejectsWire(invalidUtf8Path, /valid UTF-8/);

const invalidTask = Buffer.from(vectorBytes);
invalidTask[HEADER_BYTES] = 0x2b;
assertRejectsWire(invalidTask, /task ID/);

assert.throws(() => encodeFrame({ ...vectorInput(), offset: -1 }), /non-negative safe integer/);
assert.throws(() => encodeFrame({ ...vectorInput(), offset: Number.MAX_SAFE_INTEGER + 1 }), /non-negative safe integer/);
assert.throws(() => encodeFrame({ ...vectorInput(), sequence: -1 }), /non-negative safe integer/);
assert.throws(() => encodeFrame({ ...vectorInput(), plainLength: -1 }), /plainLength/);
assert.throws(() => encodeFrame({ ...vectorInput(), plainLength: vector.plainLength - 1 }), /ciphertext length/);
assert.throws(() => encodeFrame({ ...vectorInput(), nonce: Buffer.alloc(11) }), /exactly 12 bytes/);
assert.throws(() => encodeFrame({ ...vectorInput(), authTag: Buffer.alloc(15) }), /exactly 16 bytes/);
assert.throws(() => encodeFrame({ ...vectorInput(), relativePath: '../escape.txt' }), /path/i);
assert.throws(() => encodeFrame({ ...vectorInput(), relativePath: longRelativePath() }), /maximum UTF-8 length/);
assert.throws(() => encodeFrame({ ...vectorInput(), plaintext: Buffer.alloc(0) }), /missing or unsupported fields/);
assert.throws(() => encodeFrame({ ...vectorInput(), key: Buffer.alloc(32) }), /missing or unsupported fields/);
assert.throws(() => encodeFrame(null), /plain object/);
assert.throws(() => decodeFrame('not bytes'), /Buffer or Uint8Array/);

const oversizedCiphertext = Buffer.alloc(MAX_CHUNK_BYTES + 1);
assert.throws(() => encodeFrame({
  ...vectorInput(),
  plainLength: oversizedCiphertext.length,
  ciphertext: oversizedCiphertext
}), /plainLength/);

console.log('transfer chunk frame smoke tests passed');

function assertFrameEquals(actual, expected) {
  assert.strictEqual(actual.taskId, expected.taskId);
  assert.strictEqual(actual.relativePath, expected.relativePath);
  assert.strictEqual(actual.offset, expected.offset);
  assert.strictEqual(actual.sequence, expected.sequence);
  assert.strictEqual(actual.plainLength, expected.plainLength);
  assert.deepStrictEqual(actual.nonce, expected.nonce);
  assert.deepStrictEqual(actual.authTag, expected.authTag);
  assert.deepStrictEqual(actual.ciphertext, expected.ciphertext);
}

function assertRejectsWire(bytes, pattern) {
  assert.throws(() => decodeFrame(bytes), pattern);
}

function mutateAndReject(offset, value, pattern) {
  const changed = Buffer.from(vectorBytes);
  changed.writeUInt8(value, offset);
  assertRejectsWire(changed, pattern);
}

function mutateUInt16AndReject(offset, value, pattern) {
  const changed = Buffer.from(vectorBytes);
  changed.writeUInt16BE(value, offset);
  assertRejectsWire(changed, pattern);
}

function mutateUInt32AndReject(offset, value, pattern) {
  const changed = Buffer.from(vectorBytes);
  changed.writeUInt32BE(value, offset);
  assertRejectsWire(changed, pattern);
}

function longRelativePath() {
  return new Array(17).fill('a'.repeat(255)).join('/');
}

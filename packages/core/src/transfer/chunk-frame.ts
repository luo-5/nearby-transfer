/**
 * Binary chunk frame encoder/decoder for encrypted transfer chunks.
 * Ported from src/v2/transfer-chunk-frame.js.
 *
 * Each frame carries one encrypted chunk with its task id, path, offset,
 * sequence, nonce, auth tag, and ciphertext. The binary format uses a fixed
 * 48-byte header followed by variable-length fields.
 */

import { Buffer } from 'node:buffer';
import { TextDecoder } from 'node:util';
import { assertValidRelativePath, assertValidTaskId, MAX_RELATIVE_PATH_BYTES } from './manifest-validation.js';
import { AUTH_TAG_BYTES, MAX_CHUNK_BYTES, MAX_SEQUENCE, NONCE_BYTES } from '../crypto/session.js';

export const MAGIC = Buffer.from('NTV2CHNK', 'ascii');
export const VERSION = 1;
export const HEADER_BYTES = 48;
export const TASK_ID_CHAR_LENGTH = 22; // base64url character length of a 16-byte task id
export const FLAGS = 0;
const MAX_SAFE_INTEGER_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export const MAX_FRAME_BYTES = HEADER_BYTES + TASK_ID_CHAR_LENGTH + MAX_RELATIVE_PATH_BYTES + NONCE_BYTES + AUTH_TAG_BYTES + MAX_CHUNK_BYTES;

export interface ChunkFrameInput {
  taskId: string;
  relativePath: string;
  path?: string;
  offset: number;
  sequence: number;
  plainLength: number;
  nonce: Uint8Array;
  authTag: Uint8Array;
  ciphertext: Uint8Array;
}

export interface ChunkFrame extends Readonly<ChunkFrameInput> {
  readonly path?: string;
}

export function encodeFrame(input: ChunkFrameInput): Buffer {
  const frame = normalizeFrame(input);
  const taskIdBytes = Buffer.from(frame.taskId, 'utf8');
  const pathBytes = Buffer.from(frame.relativePath, 'utf8');
  const frameLength = HEADER_BYTES + taskIdBytes.length + pathBytes.length + NONCE_BYTES + AUTH_TAG_BYTES + frame.ciphertext.length;
  const encoded = Buffer.allocUnsafe(frameLength);

  MAGIC.copy(encoded, 0);
  encoded.writeUInt8(VERSION, 8);
  encoded.writeUInt8(FLAGS, 9);
  encoded.writeUInt16BE(HEADER_BYTES, 10);
  encoded.writeUInt32BE(frameLength, 12);
  encoded.writeUInt16BE(taskIdBytes.length, 16);
  encoded.writeUInt16BE(pathBytes.length, 18);
  encoded.writeBigUInt64BE(BigInt(frame.offset), 20);
  encoded.writeBigUInt64BE(BigInt(frame.sequence), 28);
  encoded.writeUInt32BE(frame.plainLength, 36);
  encoded.writeUInt32BE(frame.ciphertext.length, 40);
  encoded.writeUInt8(NONCE_BYTES, 44);
  encoded.writeUInt8(AUTH_TAG_BYTES, 45);
  encoded.writeUInt16BE(0, 46);

  let cursor = HEADER_BYTES;
  cursor += taskIdBytes.copy(encoded, cursor);
  cursor += pathBytes.copy(encoded, cursor);
  cursor += (Buffer.isBuffer(frame.nonce) ? frame.nonce : Buffer.from(frame.nonce)).copy(encoded, cursor);
  cursor += (Buffer.isBuffer(frame.authTag) ? frame.authTag : Buffer.from(frame.authTag)).copy(encoded, cursor);
  (Buffer.isBuffer(frame.ciphertext) ? frame.ciphertext : Buffer.from(frame.ciphertext)).copy(encoded, cursor);
  return encoded;
}

export function decodeFrame(value: Uint8Array): ChunkFrame {
  const encoded = requireBytes(value, 'Transfer chunk frame');
  const header = decodeHeader(encoded);
  if (encoded.length < header.frameLength) throw new RangeError('Transfer chunk frame is truncated');
  if (encoded.length > header.frameLength) throw new RangeError('Transfer chunk frame contains trailing bytes');
  return decodeCompleteFrame(encoded, header);
}

export class TransferChunkFrameParser {
  private pending: Buffer = Buffer.alloc(0);
  private finished = false;

  push(value: Uint8Array): ChunkFrame[] {
    if (this.finished) throw new Error('Transfer chunk frame parser is already finished');
    const chunk = requireBytes(value, 'Transfer chunk stream input');
    if (chunk.length === 0) return [];

    const input = this.pending.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.pending, chunk], this.pending.length + chunk.length);
    const frames: ChunkFrame[] = [];
    let cursor = 0;

    while (input.length - cursor >= HEADER_BYTES) {
      const header = decodeHeader(input.subarray(cursor));
      if (input.length - cursor < header.frameLength) break;
      const frameBytes = input.subarray(cursor, cursor + header.frameLength);
      frames.push(decodeCompleteFrame(frameBytes, header));
      cursor += header.frameLength;
    }

    this.pending = cursor === input.length ? Buffer.alloc(0) : Buffer.from(input.subarray(cursor));
    if (this.pending.length > MAX_FRAME_BYTES) {
      this.pending = Buffer.alloc(0);
      throw new RangeError('Buffered transfer chunk frame exceeds the maximum length');
    }
    return frames;
  }

  finish(): void {
    if (this.finished) throw new Error('Transfer chunk frame parser is already finished');
    this.finished = true;
    if (this.pending.length !== 0) {
      this.pending = Buffer.alloc(0);
      throw new RangeError('Transfer chunk stream ended with a truncated frame');
    }
  }
}

interface ChunkHeader {
  frameLength: number;
  taskIdLength: number;
  pathLength: number;
  offset: number;
  sequence: number;
  plainLength: number;
  ciphertextLength: number;
  nonceLength: number;
  authTagLength: number;
}

function decodeHeader(encoded: Buffer): ChunkHeader {
  if (encoded.length < HEADER_BYTES) throw new RangeError('Transfer chunk frame header is truncated');
  if (!encoded.subarray(0, MAGIC.length).equals(MAGIC)) throw new TypeError('Transfer chunk frame magic is invalid');
  if (encoded.readUInt8(8) !== VERSION) throw new RangeError('Unsupported transfer chunk frame version');
  if (encoded.readUInt8(9) !== FLAGS) throw new TypeError('Transfer chunk frame flags must be zero');
  if (encoded.readUInt16BE(10) !== HEADER_BYTES) throw new RangeError('Transfer chunk frame header length is invalid');

  const frameLength = encoded.readUInt32BE(12);
  const taskIdLength = encoded.readUInt16BE(16);
  const pathLength = encoded.readUInt16BE(18);
  const offset = readSafeUInt64(encoded, 20, 'Transfer chunk offset');
  const sequence = readSafeUInt64(encoded, 28, 'Transfer chunk sequence');
  const plainLength = encoded.readUInt32BE(36);
  const ciphertextLength = encoded.readUInt32BE(40);
  const nonceLength = encoded.readUInt8(44);
  const authTagLength = encoded.readUInt8(45);

  if (encoded.readUInt16BE(46) !== 0) throw new TypeError('Transfer chunk frame reserved bits must be zero');
  if (taskIdLength !== TASK_ID_CHAR_LENGTH) throw new RangeError('Transfer chunk task ID length is invalid');
  if (pathLength === 0 || pathLength > MAX_RELATIVE_PATH_BYTES) throw new RangeError('Transfer chunk path length exceeds the accepted bounds');
  if (plainLength > MAX_CHUNK_BYTES || ciphertextLength > MAX_CHUNK_BYTES) throw new RangeError('Transfer chunk payload exceeds the maximum length');
  if (ciphertextLength !== plainLength) throw new RangeError('Transfer chunk ciphertext length must equal plainLength');
  if (nonceLength !== NONCE_BYTES || authTagLength !== AUTH_TAG_BYTES) throw new RangeError('Transfer chunk nonce or authentication tag length is invalid');

  const expectedLength = HEADER_BYTES + taskIdLength + pathLength + nonceLength + authTagLength + ciphertextLength;
  if (frameLength !== expectedLength || frameLength > MAX_FRAME_BYTES) throw new RangeError('Transfer chunk frame length is inconsistent');

  return { frameLength, taskIdLength, pathLength, offset, sequence, plainLength, ciphertextLength, nonceLength, authTagLength };
}

function decodeCompleteFrame(encoded: Buffer, header: ChunkHeader): ChunkFrame {
  let cursor = HEADER_BYTES;
  const taskIdBytes = encoded.subarray(cursor, cursor + header.taskIdLength);
  cursor += header.taskIdLength;
  const pathBytes = encoded.subarray(cursor, cursor + header.pathLength);
  cursor += header.pathLength;
  const nonce = Buffer.from(encoded.subarray(cursor, cursor + header.nonceLength));
  cursor += header.nonceLength;
  const authTag = Buffer.from(encoded.subarray(cursor, cursor + header.authTagLength));
  cursor += header.authTagLength;
  const ciphertext = Buffer.from(encoded.subarray(cursor, cursor + header.ciphertextLength));

  const taskId = decodeCanonicalUtf8(taskIdBytes, 'Transfer chunk task ID');
  const relativePath = decodeCanonicalUtf8(pathBytes, 'Transfer chunk path');
  assertValidTaskId(taskId);
  assertValidRelativePath(relativePath);

  return Object.freeze({ taskId, relativePath, offset: header.offset, sequence: header.sequence, plainLength: header.plainLength, nonce, authTag, ciphertext });
}

function normalizeFrame(input: ChunkFrameInput): ChunkFrameInput & { relativePath: string } {
  assertPlainObject(input, 'Transfer chunk frame');
  const allowedKeys = ['taskId', 'relativePath', 'path', 'offset', 'sequence', 'plainLength', 'nonce', 'authTag', 'ciphertext'];
  for (const key of Object.keys(input)) {
    if (!allowedKeys.includes(key)) {
      throw new TypeError('Transfer chunk frame contains missing or unsupported fields');
    }
  }
  const relativePath = input.relativePath ?? (input as { path?: string }).path;
  if (typeof relativePath !== 'string') {
    throw new TypeError('Transfer chunk frame contains missing or unsupported fields');
  }
  assertValidTaskId(input.taskId);
  assertValidRelativePath(relativePath);
  assertSafeInteger(input.offset, 'Transfer chunk offset');
  assertSafeInteger(input.sequence, 'Transfer chunk sequence');
  if (input.sequence > MAX_SEQUENCE) throw new RangeError('Transfer chunk sequence exceeds the supported range');
  if (!Number.isInteger(input.plainLength) || input.plainLength < 0 || input.plainLength > MAX_CHUNK_BYTES) throw new RangeError('Transfer chunk plainLength exceeds the accepted bounds');

  const nonce = requireExactBytes(input.nonce, NONCE_BYTES, 'Transfer chunk nonce');
  const authTag = requireExactBytes(input.authTag, AUTH_TAG_BYTES, 'Transfer chunk authentication tag');
  const ciphertext = requireBytes(input.ciphertext, 'Transfer chunk ciphertext');
  if (ciphertext.length > MAX_CHUNK_BYTES || ciphertext.length !== input.plainLength) throw new RangeError('Transfer chunk ciphertext length must equal plainLength');

  return { taskId: input.taskId, path: relativePath, relativePath, offset: input.offset, sequence: input.sequence, plainLength: input.plainLength, nonce: Buffer.from(nonce), authTag: Buffer.from(authTag), ciphertext: Buffer.from(ciphertext) };
}

function decodeCanonicalUtf8(bytes: Buffer, subject: string): string {
  let decoded: string;
  try {
    decoded = UTF8_DECODER.decode(bytes);
  } catch (error) {
    throw new TypeError(`${subject} is not valid UTF-8`, { cause: error });
  }
  if (!Buffer.from(decoded, 'utf8').equals(bytes)) throw new TypeError(`${subject} is not canonical UTF-8`);
  return decoded;
}

function readSafeUInt64(encoded: Buffer, offset: number, subject: string): number {
  const value = encoded.readBigUInt64BE(offset);
  if (value > MAX_SAFE_INTEGER_BIGINT) throw new RangeError(`${subject} exceeds JavaScript safe integer precision`);
  return Number(value);
}

function assertSafeInteger(value: number, subject: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${subject} must be a non-negative safe integer`);
}

function requireBytes(value: Uint8Array, subject: string): Buffer {
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  throw new TypeError(`${subject} must be a Buffer or Uint8Array`);
}

function requireExactBytes(value: Uint8Array, length: number, subject: string): Buffer {
  const bytes = requireBytes(value, subject);
  if (bytes.length !== length) {
    throw new RangeError(`${subject} must contain exactly ${length} bytes`);
  }
  return bytes;
}

function assertPlainObject(value: unknown, subject: string): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${subject} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${subject} must be a plain object`);
  }
}

function assertExactKeys(value: Record<string, unknown>, expected: string[], subject: string): void {
  const actual = Object.keys(value);
  if (actual.length !== expected.length || expected.some((key) => !Object.hasOwn(value, key))) throw new TypeError(`${subject} contains missing or unsupported fields`);
}

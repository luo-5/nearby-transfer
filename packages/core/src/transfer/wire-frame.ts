/**
 * Length-prefixed wire frame encoder/decoder for protocol v2 TCP transport.
 * Ported from src/v2/wire-frame.js.
 *
 * Wire format (all integers unsigned big-endian):
 *   frameLength: u32  bytes after this field
 *   headerLength: u16  UTF-8 bytes in canonical JSON header
 *   header:       bytes
 *   payload:      bytes (optional)
 */

import { Buffer } from 'node:buffer';
import { TextDecoder } from 'node:util';
import { APP_ID, PROTOCOL_VERSION, MESSAGE_TYPES } from '../constants.js';
import { canonicalJson, parseCanonicalJson, type CanonicalValue } from '../canonical-json.js';

export const FRAME_LENGTH_BYTES = 4;
export const HEADER_LENGTH_BYTES = 2;
export const FRAME_PREFIX_BYTES = FRAME_LENGTH_BYTES + HEADER_LENGTH_BYTES;
export const MAX_FRAME_SIZE = 16 * 1024 * 1024;
export const MAX_HEADER_SIZE = 16 * 1024;
export const MAX_BUFFERED_BYTES = FRAME_LENGTH_BYTES + MAX_FRAME_SIZE;

const ALLOWED_MESSAGE_TYPES: Set<string> = new Set(Object.values(MESSAGE_TYPES));
const utf8Decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export interface WireFrame {
  header: WireHeader;
  payload: Buffer;
}

export interface WireHeader {
  app: string;
  protocolVersion: number;
  type: string;
}

export function encodeWireFrame(frame: { header: WireHeader; payload?: Uint8Array }): Buffer {
  assertPlainObject(frame, 'frame');
  assertExactKeys(frame as Record<string, unknown>, ['header'], 'frame', ['payload']);

  const headerBytes = encodeHeader(frame.header);
  const payload = normalizePayload((frame as { payload?: Uint8Array }).payload);
  const bodyLength = HEADER_LENGTH_BYTES + headerBytes.length + payload.length;

  if (bodyLength > MAX_FRAME_SIZE) {
    throw new RangeError(`Wire frame exceeds the ${MAX_FRAME_SIZE}-byte limit`);
  }

  const encoded = Buffer.allocUnsafe(FRAME_LENGTH_BYTES + bodyLength);
  encoded.writeUInt32BE(bodyLength, 0);
  encoded.writeUInt16BE(headerBytes.length, FRAME_LENGTH_BYTES);
  headerBytes.copy(encoded, FRAME_PREFIX_BYTES);
  payload.copy(encoded, FRAME_PREFIX_BYTES + headerBytes.length);
  return encoded;
}

export class WireFrameDecoder {
  buffer: Buffer = Buffer.alloc(0);

  get bufferedBytes(): number {
    return this.buffer.length;
  }

  push(chunk: Uint8Array): WireFrame[] {
    const input = normalizeChunk(chunk);
    if (input.length === 0) return [];

    if (input.length > MAX_BUFFERED_BYTES - this.buffer.length) {
      throw new RangeError(`Wire decoder buffer exceeds the ${MAX_BUFFERED_BYTES}-byte limit`);
    }

    this.buffer = this.buffer.length === 0 ? Buffer.from(input) : Buffer.concat([this.buffer, input], this.buffer.length + input.length);

    const frames: WireFrame[] = [];
    for (;;) {
      if (this.buffer.length < FRAME_LENGTH_BYTES) break;

      const frameLength = this.buffer.readUInt32BE(0);
      assertFrameLength(frameLength);
      const encodedLength = FRAME_LENGTH_BYTES + frameLength;
      if (this.buffer.length < encodedLength) break;

      frames.push(decodeCompleteFrame(this.buffer.subarray(0, encodedLength)));
      this.buffer = this.buffer.subarray(encodedLength);
    }
    return frames;
  }

  finish(): WireFrame[] {
    if (this.buffer.length !== 0) {
      throw new SyntaxError(`Truncated wire frame: ${this.buffer.length} buffered byte(s) remain at EOF`);
    }
    return [];
  }
}

export function decodeWireFrame(encoded: Uint8Array): WireFrame {
  const decoder = new WireFrameDecoder();
  const frames = decoder.push(encoded);
  decoder.finish();
  if (frames.length !== 1) {
    throw new SyntaxError(`Expected exactly one wire frame, received ${frames.length}`);
  }
  return frames[0]!;
}

function decodeCompleteFrame(encoded: Buffer): WireFrame {
  const frameLength = encoded.readUInt32BE(0);
  assertFrameLength(frameLength);
  if (encoded.length !== FRAME_LENGTH_BYTES + frameLength) {
    throw new SyntaxError('Wire frame length prefix does not match the supplied bytes');
  }

  const headerLength = encoded.readUInt16BE(FRAME_LENGTH_BYTES);
  if (headerLength === 0 || headerLength > MAX_HEADER_SIZE) {
    throw new RangeError(`Wire header length must be between 1 and ${MAX_HEADER_SIZE} bytes`);
  }
  if (HEADER_LENGTH_BYTES + headerLength > frameLength) {
    throw new SyntaxError('Wire header length exceeds its enclosing frame');
  }

  const headerStart = FRAME_PREFIX_BYTES;
  const headerEnd = headerStart + headerLength;
  const header = decodeHeader(encoded.subarray(headerStart, headerEnd));
  return { header, payload: Buffer.from(encoded.subarray(headerEnd)) };
}

function encodeHeader(header: unknown): Buffer {
  validateHeader(header);
  const serialized = canonicalJson(header as unknown as CanonicalValue);
  const bytes = Buffer.from(serialized, 'utf8');
  if (bytes.length === 0 || bytes.length > MAX_HEADER_SIZE) {
    throw new RangeError(`Wire header must be between 1 and ${MAX_HEADER_SIZE} bytes`);
  }
  return bytes;
}

function decodeHeader(bytes: Buffer): WireHeader {
  if (bytes.length === 0 || bytes.length > MAX_HEADER_SIZE) {
    throw new RangeError(`Wire header must be between 1 and ${MAX_HEADER_SIZE} bytes`);
  }
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    throw new SyntaxError('Wire header must not start with a UTF-8 byte-order mark');
  }

  let serialized: string;
  try {
    serialized = utf8Decoder.decode(bytes);
  } catch (error) {
    throw new SyntaxError(`Wire header is not valid UTF-8: ${(error as Error).message}`);
  }

  let header: unknown;
  try {
    header = JSON.parse(serialized);
  } catch (error) {
    throw new SyntaxError(`Wire header is not valid JSON: ${(error as Error).message}`);
  }

  validateHeader(header);
  const expected = canonicalJson(header as unknown as CanonicalValue);
  if (serialized !== expected) {
    throw new SyntaxError('Wire header is not canonical JSON');
  }
  return header as WireHeader;
}

function validateHeader(header: unknown): asserts header is WireHeader {
  assertPlainObject(header, 'wire header');
  assertExactKeys(header as Record<string, unknown>, ['app', 'protocolVersion', 'type'], 'wire header');
  const h = header as Record<string, unknown>;
  if (h.app !== APP_ID) throw new TypeError(`Wire header app must be ${APP_ID}`);
  if (!Number.isSafeInteger(h.protocolVersion) || h.protocolVersion !== PROTOCOL_VERSION) {
    throw new TypeError(`Wire header protocolVersion must be the integer ${PROTOCOL_VERSION}`);
  }
  if (typeof h.type !== 'string' || !ALLOWED_MESSAGE_TYPES.has(h.type)) {
    throw new TypeError('Wire header type is not a supported protocol v2 message type');
  }
}

function normalizePayload(payload: Uint8Array | undefined): Buffer {
  if (payload === undefined) return Buffer.alloc(0);
  if (!Buffer.isBuffer(payload) && !(payload instanceof Uint8Array)) {
    throw new TypeError('Wire frame payload must be a Buffer or Uint8Array');
  }
  return Buffer.from(payload);
}

function normalizeChunk(chunk: Uint8Array): Buffer {
  if (!Buffer.isBuffer(chunk) && !(chunk instanceof Uint8Array)) {
    throw new TypeError('Wire decoder chunk must be a Buffer or Uint8Array');
  }
  return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
}

function assertFrameLength(frameLength: number): void {
  if (!Number.isSafeInteger(frameLength) || frameLength < HEADER_LENGTH_BYTES || frameLength > MAX_FRAME_SIZE) {
    throw new RangeError(`Wire frame length must be an integer from ${HEADER_LENGTH_BYTES} to ${MAX_FRAME_SIZE} bytes`);
  }
}

function assertPlainObject(value: unknown, name: string): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new TypeError(`${name} must be a plain object`);
  }
}

function assertExactKeys(value: Record<string, unknown>, requiredKeys: string[], name: string, optionalKeys: string[] = []): void {
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  for (const key of requiredKeys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) throw new TypeError(`${name} is missing required field ${key}`);
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new TypeError(`${name} contains unknown field ${key}`);
  }
}

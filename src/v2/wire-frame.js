'use strict';

const { TextDecoder } = require('util');
const { canonicalJson } = require('./canonical-json');
const { APP_ID, PROTOCOL_VERSION, MESSAGE_TYPES } = require('./constants');

const FRAME_LENGTH_BYTES = 4;
const HEADER_LENGTH_BYTES = 2;
const FRAME_PREFIX_BYTES = FRAME_LENGTH_BYTES + HEADER_LENGTH_BYTES;
const MAX_FRAME_SIZE = 16 * 1024 * 1024;
const MAX_HEADER_SIZE = 16 * 1024;
const MAX_BUFFERED_BYTES = FRAME_LENGTH_BYTES + MAX_FRAME_SIZE;
const ALLOWED_MESSAGE_TYPES = new Set(Object.values(MESSAGE_TYPES));
const utf8Decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/**
 * Encode one protocol v2 frame.
 *
 * Wire format (all integer fields are unsigned big-endian):
 *
 *   frameLength: u32  Number of bytes after this field.
 *   headerLength: u16 Number of UTF-8 bytes in the canonical JSON header.
 *   header:       bytes
 *   payload:      bytes (optional, remaining frame bytes)
 */
function encodeWireFrame(frame) {
  assertPlainObject(frame, 'frame');
  assertExactKeys(frame, ['header'], 'frame', ['payload']);

  const headerBytes = encodeHeader(frame.header);
  const payload = normalizePayload(frame.payload);
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

/**
 * Incrementally decode frames from a byte stream. `push` supports half packets
 * and multiple consecutive frames. Call `finish` exactly when the transport
 * reaches EOF to reject a truncated length prefix or frame body.
 */
class WireFrameDecoder {
  constructor() {
    this.buffer = Buffer.alloc(0);
  }

  get bufferedBytes() {
    return this.buffer.length;
  }

  push(chunk) {
    const input = normalizeChunk(chunk);
    if (input.length === 0) {
      return [];
    }

    if (input.length > MAX_BUFFERED_BYTES - this.buffer.length) {
      throw new RangeError(`Wire decoder buffer exceeds the ${MAX_BUFFERED_BYTES}-byte limit`);
    }

    this.buffer = this.buffer.length === 0
      ? Buffer.from(input)
      : Buffer.concat([this.buffer, input], this.buffer.length + input.length);

    const frames = [];
    while (true) {
      if (this.buffer.length < FRAME_LENGTH_BYTES) {
        break;
      }

      const frameLength = this.buffer.readUInt32BE(0);
      assertFrameLength(frameLength);
      const encodedLength = FRAME_LENGTH_BYTES + frameLength;
      if (this.buffer.length < encodedLength) {
        break;
      }

      frames.push(decodeCompleteFrame(this.buffer.subarray(0, encodedLength)));
      this.buffer = this.buffer.subarray(encodedLength);
    }

    return frames;
  }

  finish() {
    if (this.buffer.length !== 0) {
      throw new SyntaxError(`Truncated wire frame: ${this.buffer.length} buffered byte(s) remain at EOF`);
    }
    return [];
  }
}

function decodeWireFrame(encoded) {
  const decoder = new WireFrameDecoder();
  const frames = decoder.push(encoded);
  decoder.finish();
  if (frames.length !== 1) {
    throw new SyntaxError(`Expected exactly one wire frame, received ${frames.length}`);
  }
  return frames[0];
}

function decodeCompleteFrame(encoded) {
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
  return {
    header,
    payload: Buffer.from(encoded.subarray(headerEnd))
  };
}

function encodeHeader(header) {
  validateHeader(header);
  const serialized = canonicalJson(header);
  const bytes = Buffer.from(serialized, 'utf8');
  if (bytes.length === 0 || bytes.length > MAX_HEADER_SIZE) {
    throw new RangeError(`Wire header must be between 1 and ${MAX_HEADER_SIZE} bytes`);
  }
  return bytes;
}

function decodeHeader(bytes) {
  if (bytes.length === 0 || bytes.length > MAX_HEADER_SIZE) {
    throw new RangeError(`Wire header must be between 1 and ${MAX_HEADER_SIZE} bytes`);
  }
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    throw new SyntaxError('Wire header must not start with a UTF-8 byte-order mark');
  }

  let serialized;
  try {
    serialized = utf8Decoder.decode(bytes);
  } catch (error) {
    throw new SyntaxError(`Wire header is not valid UTF-8: ${error.message}`);
  }

  let header;
  try {
    header = JSON.parse(serialized);
  } catch (error) {
    throw new SyntaxError(`Wire header is not valid JSON: ${error.message}`);
  }

  validateHeader(header);
  const expected = canonicalJson(header);
  if (serialized !== expected) {
    throw new SyntaxError('Wire header is not canonical JSON');
  }
  return header;
}

function validateHeader(header) {
  assertPlainObject(header, 'wire header');
  assertExactKeys(header, ['app', 'protocolVersion', 'type'], 'wire header');
  if (header.app !== APP_ID) {
    throw new TypeError(`Wire header app must be ${APP_ID}`);
  }
  if (!Number.isSafeInteger(header.protocolVersion) || header.protocolVersion !== PROTOCOL_VERSION) {
    throw new TypeError(`Wire header protocolVersion must be the integer ${PROTOCOL_VERSION}`);
  }
  if (typeof header.type !== 'string' || !ALLOWED_MESSAGE_TYPES.has(header.type)) {
    throw new TypeError('Wire header type is not a supported protocol v2 message type');
  }
}

function normalizePayload(payload) {
  if (payload === undefined) {
    return Buffer.alloc(0);
  }
  if (!Buffer.isBuffer(payload) && !(payload instanceof Uint8Array)) {
    throw new TypeError('Wire frame payload must be a Buffer or Uint8Array');
  }
  return Buffer.from(payload);
}

function normalizeChunk(chunk) {
  if (!Buffer.isBuffer(chunk) && !(chunk instanceof Uint8Array)) {
    throw new TypeError('Wire decoder chunk must be a Buffer or Uint8Array');
  }
  return Buffer.from(chunk);
}

function assertFrameLength(frameLength) {
  if (!Number.isSafeInteger(frameLength) || frameLength < HEADER_LENGTH_BYTES || frameLength > MAX_FRAME_SIZE) {
    throw new RangeError(`Wire frame length must be an integer from ${HEADER_LENGTH_BYTES} to ${MAX_FRAME_SIZE} bytes`);
  }
}

function assertPlainObject(value, name) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new TypeError(`${name} must be a plain object`);
  }
}

function assertExactKeys(value, requiredKeys, name, optionalKeys = []) {
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  const keys = Object.keys(value);
  for (const key of requiredKeys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      throw new TypeError(`${name} is missing required field ${key}`);
    }
  }
  for (const key of keys) {
    if (!allowed.has(key)) {
      throw new TypeError(`${name} contains unknown field ${key}`);
    }
  }
}

module.exports = {
  FRAME_LENGTH_BYTES,
  HEADER_LENGTH_BYTES,
  FRAME_PREFIX_BYTES,
  MAX_FRAME_SIZE,
  MAX_HEADER_SIZE,
  MAX_BUFFERED_BYTES,
  encodeWireFrame,
  decodeWireFrame,
  WireFrameDecoder
};
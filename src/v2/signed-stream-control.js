'use strict';

const crypto = require('crypto');
const { TextDecoder } = require('util');
const { APP_ID, MESSAGE_TYPES, PROTOCOL_VERSION } = require('./constants');
const { canonicalJson, parseCanonicalJson } = require('./canonical-json');
const { assertValidTaskId } = require('./transfer-manifest');
const { assertValidSessionId } = require('./transfer-message-codec');

const CONTROL_PROTOCOL = 1;
const MAX_ENCODED_BYTES = 16 * 1024;
const DEFAULT_TTL_MS = 30 * 1000;
const MAX_TTL_MS = 5 * 60 * 1000;
const CLOCK_SKEW_MS = 30 * 1000;
const DEVICE_ID_PATTERN = /^[a-f0-9]{16}$/;
const SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{86}$/;
const CONTROL_COMMANDS = new Set([
  'stream-hello',
  'stream-start',
  'stream-pause',
  'stream-paused',
  'stream-resume',
  'stream-resumed',
  'stream-complete',
  'stream-complete-ack',
  'stream-cancel'
]);
const CANCEL_CODES = new Set(['cancelled', 'timeout', 'protocol-error', 'transfer-error']);
const CORE_FIELDS = ['type', 'protocol', 'taskId', 'fromPeerId', 'toPeerId', 'direction'];
const SIGNED_FIELDS = [
  'app',
  'protocolVersion',
  'type',
  'command',
  'controlProtocol',
  'taskId',
  'sessionId',
  'fromDeviceId',
  'toDeviceId',
  'direction',
  'sequence',
  'issuedAt',
  'expiresAt'
];
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function createSignedStreamControlCodec({ localDevice, remotePeer, taskId, sessionId, now = Date.now, ttlMs = DEFAULT_TTL_MS }) {
  const localDeviceId = readDeviceId(localDevice, 'Local device');
  const remoteIdentity = remotePeer && remotePeer.identity ? remotePeer.identity : remotePeer;
  const remoteDeviceId = readDeviceId(remoteIdentity, 'Remote peer');
  if (localDeviceId === remoteDeviceId) throw new TypeError('Local and remote device IDs must differ');
  assertValidTaskId(taskId);
  assertValidSessionId(sessionId);
  if (typeof now !== 'function') throw new TypeError('Stream control clock must be a function');
  assertTtl(ttlMs);

  const signingPrivateKey = readEd25519PrivateKey(localDevice && localDevice.signingPrivateKey);
  const remoteSigningPublicKey = readEd25519PublicKey(remoteIdentity && remoteIdentity.signingPublicKey);
  assertLocalPublicKeyMatches(localDevice, signingPrivateKey);

  let nextLocalSequence = 0;
  let nextRemoteSequence = 0;
  let localDirection = null;
  const authenticatedValues = new WeakMap();

  function encodeControl(coreMessage) {
    const core = inspectCoreMessage(coreMessage);
    assertCoreBinding(core, localDeviceId, remoteDeviceId, taskId);
    assertLocalDirection(core.direction, localDirection);
    if (!Number.isSafeInteger(nextLocalSequence)) {
      throw new RangeError('Stream control local sequence is exhausted');
    }

    const issuedAt = readClock(now);
    if (issuedAt > Number.MAX_SAFE_INTEGER - ttlMs) {
      throw new RangeError('Stream control expiration exceeds safe integer precision');
    }
    const unsigned = {
      app: APP_ID,
      protocolVersion: PROTOCOL_VERSION,
      type: MESSAGE_TYPES.TRANSFER_STREAM_CONTROL,
      command: core.type,
      controlProtocol: CONTROL_PROTOCOL,
      taskId,
      sessionId,
      fromDeviceId: localDeviceId,
      toDeviceId: remoteDeviceId,
      direction: core.direction,
      sequence: nextLocalSequence,
      issuedAt,
      expiresAt: issuedAt + ttlMs
    };
    if (core.type === 'stream-cancel') unsigned.code = core.code;

    const signature = crypto.sign(
      null,
      Buffer.from(canonicalJson(unsigned), 'utf8'),
      signingPrivateKey
    ).toString('base64url');
    assertCanonicalSignature(signature);
    const encoded = Buffer.from(canonicalJson({ ...unsigned, signature }), 'utf8');
    if (encoded.length === 0 || encoded.length > MAX_ENCODED_BYTES) {
      throw new RangeError('Encoded stream control exceeds 16 KiB');
    }

    localDirection = core.direction;
    nextLocalSequence += 1;
    return encoded;
  }

  function decodeControl(bytes) {
    const input = requireBytes(bytes);
    if (input.length === 0 || input.length > MAX_ENCODED_BYTES) {
      throw new RangeError('Encoded stream control must be between 1 byte and 16 KiB');
    }

    let serialized;
    try {
      serialized = UTF8_DECODER.decode(input);
    } catch (_error) {
      throw new SyntaxError('Stream control is not valid UTF-8');
    }
    if (!Buffer.from(serialized, 'utf8').equals(input)) {
      throw new SyntaxError('Stream control is not canonical UTF-8');
    }

    const signed = parseCanonicalJson(serialized, 'Stream control');
    inspectSignedMessage(signed);
    assertSignedBinding(signed, remoteDeviceId, localDeviceId, taskId, sessionId);
    assertFreshTimestamp(signed, readClock(now));
    if (!Number.isSafeInteger(nextRemoteSequence)) {
      throw new RangeError('Stream control remote sequence is exhausted');
    }
    if (signed.sequence !== nextRemoteSequence) {
      throw new Error(`Stream control sequence must be exactly ${nextRemoteSequence}`);
    }

    const signature = Buffer.from(signed.signature, 'base64url');
    const unsigned = copyUnsignedMessage(signed);
    if (!crypto.verify(
      null,
      Buffer.from(canonicalJson(unsigned), 'utf8'),
      remoteSigningPublicKey,
      signature
    )) {
      throw new Error('Stream control signature verification failed');
    }

    const decoded = {
      type: signed.command,
      protocol: signed.controlProtocol,
      taskId: signed.taskId,
      fromPeerId: signed.fromDeviceId,
      toPeerId: signed.toDeviceId,
      direction: signed.direction
    };
    if (signed.command === 'stream-cancel') decoded.code = signed.code;
    const result = Object.freeze(decoded);
    authenticatedValues.set(result, Object.freeze({
      sequence: signed.sequence,
      direction: signed.direction,
      issuedAt: signed.issuedAt,
      expiresAt: signed.expiresAt
    }));
    return result;
  }

  function verifyControl(decoded) {
    if (!decoded || typeof decoded !== 'object') return false;
    const metadata = authenticatedValues.get(decoded);
    if (!metadata) return false;
    authenticatedValues.delete(decoded);

    try {
      if (metadata.sequence !== nextRemoteSequence) return false;
      assertFreshTimeRange(metadata.issuedAt, metadata.expiresAt, readClock(now));
      const expectedRemoteDirection = localDirection === null ? null : oppositeDirection(localDirection);
      if (expectedRemoteDirection !== null && metadata.direction !== expectedRemoteDirection) return false;

      if (localDirection === null) localDirection = oppositeDirection(metadata.direction);
      nextRemoteSequence += 1;
      return true;
    } catch (_error) {
      return false;
    }
  }

  return Object.freeze({ encodeControl, decodeControl, verifyControl });
}

function inspectCoreMessage(value) {
  assertPlainDataObject(value, 'Transfer stream control');
  const command = readDataField(value, 'type', 'Transfer stream control');
  const expectedFields = command === 'stream-cancel' ? [...CORE_FIELDS, 'code'] : CORE_FIELDS;
  assertExactFields(value, expectedFields, 'Transfer stream control');
  if (!CONTROL_COMMANDS.has(command)) throw new TypeError('Transfer stream control command is unsupported');
  if (value.protocol !== CONTROL_PROTOCOL) throw new TypeError('Transfer stream control protocol is unsupported');
  assertValidTaskId(value.taskId);
  assertDeviceId(value.fromPeerId, 'Transfer stream control sender');
  assertDeviceId(value.toPeerId, 'Transfer stream control receiver');
  assertDirection(value.direction);
  if (command === 'stream-cancel' && !CANCEL_CODES.has(value.code)) {
    throw new TypeError('Transfer stream cancellation code is invalid');
  }
  return value;
}

function inspectSignedMessage(value) {
  assertPlainDataObject(value, 'Signed stream control');
  const command = readDataField(value, 'command', 'Signed stream control');
  const expectedFields = command === 'stream-cancel'
    ? [...SIGNED_FIELDS, 'code', 'signature']
    : [...SIGNED_FIELDS, 'signature'];
  assertExactFields(value, expectedFields, 'Signed stream control');
  if (value.app !== APP_ID || value.protocolVersion !== PROTOCOL_VERSION ||
      value.type !== MESSAGE_TYPES.TRANSFER_STREAM_CONTROL || value.controlProtocol !== CONTROL_PROTOCOL) {
    throw new TypeError('Signed stream control has an unsupported protocol envelope');
  }
  if (!CONTROL_COMMANDS.has(command)) throw new TypeError('Signed stream control command is unsupported');
  assertValidTaskId(value.taskId);
  assertValidSessionId(value.sessionId);
  assertDeviceId(value.fromDeviceId, 'Signed stream control sender');
  assertDeviceId(value.toDeviceId, 'Signed stream control receiver');
  if (value.fromDeviceId === value.toDeviceId) throw new TypeError('Stream control device IDs must differ');
  assertDirection(value.direction);
  if (!Number.isSafeInteger(value.sequence) || value.sequence < 0) {
    throw new TypeError('Stream control sequence must be a nonnegative safe integer');
  }
  assertPositiveSafeInteger(value.issuedAt, 'Stream control issue time');
  assertPositiveSafeInteger(value.expiresAt, 'Stream control expiration time');
  if (command === 'stream-cancel' && !CANCEL_CODES.has(value.code)) {
    throw new TypeError('Stream control cancellation code is invalid');
  }
  assertCanonicalSignature(value.signature);
}

function copyUnsignedMessage(value) {
  const unsigned = {};
  for (const field of SIGNED_FIELDS) unsigned[field] = value[field];
  if (value.command === 'stream-cancel') unsigned.code = value.code;
  return unsigned;
}

function assertCoreBinding(value, localDeviceId, remoteDeviceId, taskId) {
  if (value.taskId !== taskId) throw new Error('Transfer stream control task does not match this codec');
  if (value.fromPeerId !== localDeviceId || value.toPeerId !== remoteDeviceId) {
    throw new Error('Transfer stream control identities do not match this codec');
  }
}

function assertSignedBinding(value, remoteDeviceId, localDeviceId, taskId, sessionId) {
  if (value.taskId !== taskId) throw new Error('Signed stream control task does not match this codec');
  if (value.sessionId !== sessionId) throw new Error('Signed stream control session does not match this codec');
  if (value.fromDeviceId !== remoteDeviceId || value.toDeviceId !== localDeviceId) {
    throw new Error('Signed stream control identities do not match this codec');
  }
}

function assertLocalDirection(direction, boundDirection) {
  if (boundDirection !== null && direction !== boundDirection) {
    throw new Error('Transfer stream control direction conflicts with this codec');
  }
}

function assertFreshTimestamp(value, currentTime) {
  assertFreshTimeRange(value.issuedAt, value.expiresAt, currentTime);
}

function assertFreshTimeRange(issuedAt, expiresAt, currentTime) {
  if (expiresAt <= issuedAt || expiresAt - issuedAt > MAX_TTL_MS) {
    throw new Error('Stream control validity period is invalid');
  }
  if (issuedAt > currentTime && issuedAt - currentTime > CLOCK_SKEW_MS) {
    throw new Error('Stream control issue time is too far in the future');
  }
  if (currentTime > expiresAt && currentTime - expiresAt > CLOCK_SKEW_MS) {
    throw new Error('Stream control has expired');
  }
}

function readClock(now) {
  const value = now();
  assertPositiveSafeInteger(value, 'Stream control clock value');
  return value;
}

function assertTtl(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_TTL_MS) {
    throw new RangeError(`Stream control TTL must be between 1 and ${MAX_TTL_MS} milliseconds`);
  }
}

function readDeviceId(value, subject) {
  if (!value || typeof value !== 'object') throw new TypeError(`${subject} is required`);
  assertDeviceId(value.deviceId, subject);
  return value.deviceId;
}

function assertDeviceId(value, subject) {
  if (typeof value !== 'string' || !DEVICE_ID_PATTERN.test(value)) {
    throw new TypeError(`${subject} device ID must be 16 lowercase hexadecimal characters`);
  }
}

function assertDirection(value) {
  if (value !== 'send' && value !== 'receive') throw new TypeError('Stream control direction is invalid');
}

function assertPositiveSafeInteger(value, subject) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${subject} must be a positive safe integer`);
}

function assertCanonicalSignature(value) {
  if (typeof value !== 'string' || !SIGNATURE_PATTERN.test(value)) {
    throw new TypeError('Stream control signature must be an unpadded base64url Ed25519 signature');
  }
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.length !== 64 || bytes.toString('base64url') !== value) {
    throw new TypeError('Stream control signature must be exactly 64 canonical bytes');
  }
}

function readEd25519PrivateKey(value) {
  let key;
  try {
    key = crypto.createPrivateKey(value);
  } catch (_error) {
    throw new TypeError('Local device signing private key is unreadable');
  }
  if (key.asymmetricKeyType !== 'ed25519') throw new TypeError('Local device signing key must be Ed25519');
  return key;
}

function readEd25519PublicKey(value) {
  let key;
  try {
    key = crypto.createPublicKey(value);
  } catch (_error) {
    throw new TypeError('Remote peer signing public key is unreadable');
  }
  if (key.asymmetricKeyType !== 'ed25519') throw new TypeError('Remote peer signing key must be Ed25519');
  return key;
}

function assertLocalPublicKeyMatches(localDevice, privateKey) {
  if (!localDevice || localDevice.signingPublicKey === undefined) return;
  const supplied = readEd25519PublicKey(localDevice.signingPublicKey);
  const derived = crypto.createPublicKey(privateKey);
  const suppliedDer = supplied.export({ type: 'spki', format: 'der' });
  const derivedDer = derived.export({ type: 'spki', format: 'der' });
  if (!crypto.timingSafeEqual(suppliedDer, derivedDer)) {
    throw new TypeError('Local device signing key pair does not match');
  }
}

function requireBytes(value) {
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  throw new TypeError('Encoded stream control must be a Buffer or Uint8Array');
}

function assertPlainDataObject(value, subject) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${subject} must be a plain object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError(`${subject} must be a plain object`);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !descriptor || !descriptor.enumerable || !('value' in descriptor)) {
      throw new TypeError(`${subject} must contain only enumerable string data properties`);
    }
  }
}

function readDataField(value, key, subject) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
    throw new TypeError(`${subject} is missing ${key}`);
  }
  return descriptor.value;
}

function assertExactFields(value, expectedFields, subject) {
  const expected = new Set(expectedFields);
  for (const field of expectedFields) {
    if (!Object.hasOwn(value, field)) throw new TypeError(`${subject} is missing ${field}`);
  }
  for (const field of Object.keys(value)) {
    if (!expected.has(field)) throw new TypeError(`${subject} contains unknown field ${field}`);
  }
}

function oppositeDirection(direction) {
  return direction === 'send' ? 'receive' : 'send';
}

module.exports = {
  MAX_ENCODED_BYTES,
  createSignedStreamControlCodec
};

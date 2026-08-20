'use strict';

const crypto = require('crypto');
const {
  APP_ID,
  MESSAGE_TYPES,
  PROTOCOL_VERSION
} = require('./constants');
const { normalizeTransferManifest, serializeTransferManifest } = require('./transfer-manifest');
const {
  MAX_MESSAGE_TTL_MS,
  MAX_TRANSFER_MESSAGE_BYTES,
  assertValidSessionId,
  TYPE_TRANSFER_DECISION,
  TYPE_TRANSFER_MANIFEST,
  TYPE_TRANSFER_RESUME,
  advanceTransferControlCheckpoint,
  decodeTransferMessage,
  encodeTransferMessage
} = require('./transfer-message-codec');
const {
  signTransferMessage,
  verifyTransferMessage
} = require('./transfer-message-auth');
const {
  FRAME_LENGTH_BYTES,
  HEADER_LENGTH_BYTES,
  MAX_FRAME_SIZE,
  MAX_HEADER_SIZE,
  decodeWireFrame,
  encodeWireFrame
} = require('./wire-frame');

const DEFAULT_TTL_MS = 30 * 1000;
const DEFAULT_TIMEOUT_MS = 90 * 1000;
const MAX_TIMEOUT_MS = 10 * 60 * 1000;
const DEVICE_ID_PATTERN = /^[a-f0-9]{16}$/;
const MAX_BOOTSTRAP_FRAME_BODY_BYTES = HEADER_LENGTH_BYTES + MAX_HEADER_SIZE + MAX_TRANSFER_MESSAGE_BYTES;

/**
 * Send one authenticated transfer manifest and await its authenticated decision.
 *
 * The stream must be exclusively owned by the caller during bootstrap. On
 * success it is returned to paused mode with this module's listeners removed,
 * ready for TransferStreamSession to take ownership without losing bytes.
 */
function bootstrapOutgoingTransfer(input) {
  const config = normalizeInput(input);
  const requestFrame = createRequestFrame(config);

  return exchangeBootstrapFrames(config, requestFrame);
}

function createRequestFrame(config) {
  const issuedAt = readClock(config.clock);
  if (issuedAt > Number.MAX_SAFE_INTEGER - config.ttlMs) {
    throw new RangeError('Transfer bootstrap expiration exceeds safe integer precision');
  }

  const signed = signTransferMessage(TYPE_TRANSFER_MANIFEST, {
    app: APP_ID,
    protocolVersion: PROTOCOL_VERSION,
    type: TYPE_TRANSFER_MANIFEST,
    manifest: config.manifest,
    senderDeviceId: config.localDeviceId,
    receiverDeviceId: config.remoteDeviceId,
    senderEphemeralPublicKey: config.senderEphemeralPublicKey,
    sessionId: config.sessionId,
    issuedAt,
    expiresAt: issuedAt + config.ttlMs
  }, config.signingPrivateKey, { now: issuedAt });

  return encodeWireFrame({
    header: {
      app: APP_ID,
      protocolVersion: PROTOCOL_VERSION,
      type: MESSAGE_TYPES.TRANSFER_MANIFEST
    },
    payload: encodeTransferMessage(TYPE_TRANSFER_MANIFEST, signed, { now: issuedAt })
  });
}

function exchangeBootstrapFrames(config, requestFrame) {
  const stream = config.stream;

  return new Promise((resolve, reject) => {
    let settled = false;
    let writeComplete = false;
    let decision = null;
    let resume = null;
    let checkpoint = null;
    let controlCheckpoint = null;
    let expectedFrameBytes = null;
    let receivedBytes = 0;
    let pumping = false;
    let completionCheck = null;
    let chunks = [];

    const timer = setTimeout(() => {
      failClosed(new Error(`Transfer bootstrap timed out after ${config.timeoutMs} milliseconds`));
    }, config.timeoutMs);

    function cleanup() {
      clearTimeout(timer);
      if (completionCheck !== null) {
        clearImmediate(completionCheck);
        completionCheck = null;
      }
      stream.removeListener('readable', onReadable);
      stream.removeListener('end', onEnd);
      stream.removeListener('close', onClose);
      stream.removeListener('error', onError);
    }

    function failClosed(error) {
      if (settled) return;
      settled = true;
      cleanup();
      stream.pause();
      if (!stream.destroyed) stream.destroy();
      reject(normalizeError(error));
    }

    function succeed() {
      if (settled) return;
      settled = true;
      cleanup();
      stream.pause();
      resolve(Object.freeze({
        ...decision,
        resume,
        checkpoint,
        controlCheckpoint
      }));
    }

    function scheduleCompletion() {
      if (settled || !writeComplete || !exchangeComplete() || completionCheck !== null) return;
      completionCheck = setImmediate(() => {
        completionCheck = null;
        if (settled) return;
        if (stream.readableLength > 0 && decision.decision !== 'accepted') {
          failClosed(new Error('Unexpected bytes followed the transfer decision during bootstrap'));
          return;
        }
        succeed();
      });
    }

    function exchangeComplete() {
      return decision !== null && (decision.decision !== 'accepted' || resume !== null);
    }

    function onReadable() {
      if (settled || pumping) return;
      if (exchangeComplete()) {
        if (stream.readableLength > 0 && decision.decision !== 'accepted') {
          failClosed(new Error('Unexpected bytes followed the transfer decision during bootstrap'));
        } else {
          scheduleCompletion();
        }
        return;
      }

      pumping = true;
      try {
        while (!settled && !exchangeComplete()) {
          const target = expectedFrameBytes === null ? FRAME_LENGTH_BYTES : expectedFrameBytes;
          const remaining = target - receivedBytes;
          if (remaining <= 0) {
            if (expectedFrameBytes === null) {
              expectedFrameBytes = inspectFrameLength(Buffer.concat(chunks, receivedBytes));
              continue;
            }
            acceptBootstrapFrame(Buffer.concat(chunks, receivedBytes));
            expectedFrameBytes = null;
            receivedBytes = 0;
            chunks = [];
            continue;
          }

          const chunk = stream.read(remaining);
          if (chunk === null) break;
          if (!Buffer.isBuffer(chunk) && !(chunk instanceof Uint8Array)) {
            throw new TypeError('Transfer bootstrap stream returned a non-byte chunk');
          }
          const bytes = Buffer.from(chunk);
          if (bytes.length === 0 || bytes.length > remaining) {
            throw new Error('Transfer bootstrap stream violated bounded read semantics');
          }
          chunks.push(bytes);
          receivedBytes += bytes.length;
        }
      } catch (error) {
        failClosed(error);
      } finally {
        pumping = false;
      }
    }

    function acceptBootstrapFrame(encodedFrame) {
      if (decision === null) acceptDecision(encodedFrame);
      else acceptResume(encodedFrame);
    }

    function acceptDecision(encodedFrame) {
      const frame = decodeWireFrame(encodedFrame);
      if (frame.header.type !== MESSAGE_TYPES.TRANSFER_DECISION) {
        throw new TypeError('Transfer bootstrap expected a transfer-decision frame');
      }

      const receivedAt = readClock(config.clock);
      const normalized = decodeTransferMessage(TYPE_TRANSFER_DECISION, frame.payload, { now: receivedAt });
      if (!verifyTransferMessage(
        TYPE_TRANSFER_DECISION,
        normalized,
        config.remoteSigningPublicKey,
        { now: receivedAt }
      )) {
        throw new Error('Transfer decision signature verification failed');
      }
      if (normalized.taskId !== config.manifest.taskId) {
        throw new Error('Transfer decision task does not match the requested transfer');
      }
      if (normalized.sessionId !== config.sessionId) {
        throw new Error('Transfer decision session does not match the requested transfer');
      }
      if (normalized.senderDeviceId !== config.remoteDeviceId ||
          normalized.receiverDeviceId !== config.localDeviceId) {
        throw new Error('Transfer decision route does not match the requested transfer');
      }

      decision = normalized;
      if (stream.readableLength > 0 && decision.decision !== 'accepted') {
        throw new Error('Unexpected bytes followed the transfer decision during bootstrap');
      }
      scheduleCompletion();
    }

    function acceptResume(encodedFrame) {
      if (decision === null || decision.decision !== 'accepted') {
        throw new Error('Transfer resume arrived before an accepted decision');
      }
      const frame = decodeWireFrame(encodedFrame);
      if (frame.header.type !== MESSAGE_TYPES.TRANSFER_RESUME) {
        throw new TypeError('Accepted transfer bootstrap expected a transfer-resume frame');
      }
      const receivedAt = readClock(config.clock);
      const normalized = decodeTransferMessage(TYPE_TRANSFER_RESUME, frame.payload, { now: receivedAt });
      if (!verifyTransferMessage(
        TYPE_TRANSFER_RESUME,
        normalized,
        config.remoteSigningPublicKey,
        { now: receivedAt }
      )) {
        throw new Error('Transfer resume signature verification failed');
      }
      if (normalized.taskId !== config.manifest.taskId) {
        throw new Error('Transfer resume task does not match the requested transfer');
      }
      if (normalized.sessionId !== config.sessionId) {
        throw new Error('Transfer resume session does not match the requested transfer');
      }
      if (normalized.senderDeviceId !== config.remoteDeviceId ||
          normalized.receiverDeviceId !== config.localDeviceId) {
        throw new Error('Transfer resume route does not match the requested transfer');
      }
      if (normalized.manifestHash !== config.manifestHash) {
        throw new Error('Transfer resume manifest hash does not match the requested transfer');
      }

      const receiverCheckpoint = normalizeBootstrapCheckpoint({
        files: normalized.files,
        totalTransferred: normalized.totalTransferred,
        nextSequence: normalized.nextSequence
      }, config.manifest, 'Receiver transfer checkpoint');
      assertCheckpointNotBehind(config.checkpoint, receiverCheckpoint);
      controlCheckpoint = advanceTransferControlCheckpoint(TYPE_TRANSFER_RESUME, normalized, { now: receivedAt });
      checkpoint = receiverCheckpoint;
      resume = normalized;
      scheduleCompletion();
    }

    function onEnd() {
      onReadable();
      if (settled) return;
      if (exchangeComplete()) {
        scheduleCompletion();
        return;
      }
      failClosed(new Error('Transfer bootstrap stream ended before a usable decision was received'));
    }

    function onClose() {
      if (settled) return;
      if (exchangeComplete()) {
        scheduleCompletion();
        return;
      }
      failClosed(new Error('Transfer bootstrap stream closed before a usable decision was received'));
    }

    function onError(error) {
      failClosed(error);
    }

    stream.pause();
    stream.on('readable', onReadable);
    stream.once('end', onEnd);
    stream.once('close', onClose);
    stream.on('error', onError);

    try {
      stream.write(requestFrame, (error) => {
        if (error) {
          failClosed(error);
          return;
        }
        writeComplete = true;
        scheduleCompletion();
      });
    } catch (error) {
      failClosed(error);
    }
  });
}

function inspectFrameLength(prefix) {
  if (prefix.length !== FRAME_LENGTH_BYTES) {
    throw new Error('Transfer bootstrap frame prefix is incomplete');
  }
  const frameLength = prefix.readUInt32BE(0);
  if (frameLength < HEADER_LENGTH_BYTES || frameLength > MAX_FRAME_SIZE
      || frameLength > MAX_BOOTSTRAP_FRAME_BODY_BYTES) {
    throw new RangeError(`Transfer bootstrap frame length must be between ${HEADER_LENGTH_BYTES} and ${MAX_BOOTSTRAP_FRAME_BODY_BYTES} bytes`);
  }
  return FRAME_LENGTH_BYTES + frameLength;
}

function normalizeInput(input) {
  assertPlainObject(input, 'Transfer bootstrap input');
  assertExactKeys(input, [
    'stream',
    'localDevice',
    'remotePeer',
    'manifest',
    'senderEphemeralPublicKey',
    'sessionId'
  ], ['checkpoint', 'clock', 'ttlMs', 'timeoutMs'], 'Transfer bootstrap input');

  const stream = input.stream;
  assertUsableStream(stream);
  const localDevice = requireIdentity(input.localDevice, 'Local device');
  const remoteIdentity = input.remotePeer && input.remotePeer.identity
    ? requireIdentity(input.remotePeer.identity, 'Remote peer identity')
    : requireIdentity(input.remotePeer, 'Remote peer');
  if (localDevice.deviceId === remoteIdentity.deviceId) {
    throw new TypeError('Local and remote device IDs must differ');
  }
  if (typeof input.localDevice.signingPrivateKey !== 'string') {
    throw new TypeError('Local device signing private key is required');
  }
  if (typeof remoteIdentity.signingPublicKey !== 'string') {
    throw new TypeError('Remote peer signing public key is required');
  }

  const clock = input.clock === undefined ? Date.now : input.clock;
  if (typeof clock !== 'function') throw new TypeError('Transfer bootstrap clock must be a function');
  const ttlMs = input.ttlMs === undefined ? DEFAULT_TTL_MS : input.ttlMs;
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > MAX_MESSAGE_TTL_MS) {
    throw new RangeError(`Transfer bootstrap TTL must be between 1 and ${MAX_MESSAGE_TTL_MS} milliseconds`);
  }
  const timeoutMs = input.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : input.timeoutMs;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new RangeError(`Transfer bootstrap timeout must be between 1 and ${MAX_TIMEOUT_MS} milliseconds`);
  }
  assertValidSessionId(input.sessionId);
  const manifest = normalizeTransferManifest(input.manifest);
  const checkpoint = normalizeBootstrapCheckpoint(
    input.checkpoint === undefined ? initialCheckpoint(manifest) : input.checkpoint,
    manifest,
    'Local transfer checkpoint'
  );

  return {
    stream,
    localDeviceId: localDevice.deviceId,
    remoteDeviceId: remoteIdentity.deviceId,
    signingPrivateKey: input.localDevice.signingPrivateKey,
    remoteSigningPublicKey: remoteIdentity.signingPublicKey,
    manifest,
    manifestHash: crypto.createHash('sha256')
      .update(serializeTransferManifest(manifest), 'utf8')
      .digest('hex'),
    checkpoint,
    senderEphemeralPublicKey: input.senderEphemeralPublicKey,
    sessionId: input.sessionId,
    clock,
    ttlMs,
    timeoutMs
  };
}

function initialCheckpoint(manifest) {
  return {
    files: manifest.entries
      .filter((entry) => entry.kind === 'file')
      .map((entry) => ({
        path: entry.path,
        size: entry.size,
        committedOffset: 0,
        completed: false
      })),
    totalTransferred: 0,
    nextSequence: 0
  };
}

function normalizeBootstrapCheckpoint(value, manifest, subject) {
  assertPlainObject(value, subject);
  assertExactKeys(value, ['files', 'totalTransferred', 'nextSequence'], [], subject);
  if (!Array.isArray(value.files)) throw new TypeError(`${subject} files must be an array`);
  if (!Number.isSafeInteger(value.totalTransferred) || value.totalTransferred < 0) {
    throw new TypeError(`${subject} total transferred must be a non-negative safe integer`);
  }
  if (!Number.isSafeInteger(value.nextSequence) || value.nextSequence < 0) {
    throw new TypeError(`${subject} next sequence must be a non-negative safe integer`);
  }

  const manifestFiles = manifest.entries.filter((entry) => entry.kind === 'file');
  if (value.files.length !== manifestFiles.length) {
    throw new TypeError(`${subject} must contain every manifest file exactly once`);
  }
  const byPath = new Map();
  for (const file of value.files) {
    assertPlainObject(file, `${subject} file`);
    assertExactKeys(file, ['path', 'size', 'committedOffset', 'completed'], [], `${subject} file`);
    if (typeof file.path !== 'string' || byPath.has(file.path)) {
      throw new TypeError(`${subject} contains a duplicate or invalid file path`);
    }
    byPath.set(file.path, file);
  }

  let totalTransferred = 0;
  let incompleteSeen = false;
  const files = manifestFiles.map((expected) => {
    const file = byPath.get(expected.path);
    if (!file || file.size !== expected.size || !Number.isSafeInteger(file.committedOffset) ||
        file.committedOffset < 0 || file.committedOffset > expected.size ||
        typeof file.completed !== 'boolean') {
      throw new TypeError(`${subject} file metadata does not match the transfer manifest`);
    }
    if ((file.completed && file.committedOffset !== file.size) ||
        (!file.completed && file.size > 0 && file.committedOffset === file.size)) {
      throw new TypeError(`${subject} contains an inconsistent file completion marker`);
    }
    if (incompleteSeen && (file.completed || file.committedOffset !== 0)) {
      throw new TypeError(`${subject} must describe a contiguous manifest prefix`);
    }
    if (!file.completed) incompleteSeen = true;
    if (totalTransferred > Number.MAX_SAFE_INTEGER - file.committedOffset) {
      throw new RangeError(`${subject} total exceeds safe integer precision`);
    }
    totalTransferred += file.committedOffset;
    return Object.freeze({
      path: file.path,
      size: file.size,
      committedOffset: file.committedOffset,
      completed: file.completed
    });
  });
  if (byPath.size !== manifestFiles.length || totalTransferred !== value.totalTransferred) {
    throw new TypeError(`${subject} aggregate does not match its file checkpoints`);
  }
  return Object.freeze({ files: Object.freeze(files), totalTransferred, nextSequence: value.nextSequence });
}

function assertCheckpointNotBehind(previous, candidate) {
  if (candidate.totalTransferred < previous.totalTransferred ||
      candidate.nextSequence < previous.nextSequence) {
    throw new Error('Receiver transfer checkpoint moved backwards');
  }
  for (let index = 0; index < previous.files.length; index += 1) {
    const before = previous.files[index];
    const after = candidate.files[index];
    if (after.path !== before.path || after.size !== before.size ||
        after.committedOffset < before.committedOffset ||
        (before.completed && !after.completed)) {
      throw new Error('Receiver transfer checkpoint moved backwards or changed the manifest');
    }
  }
}

function assertUsableStream(stream) {
  if (!stream || typeof stream.on !== 'function' || typeof stream.once !== 'function' ||
      typeof stream.removeListener !== 'function' || typeof stream.pause !== 'function' ||
      typeof stream.read !== 'function' || typeof stream.write !== 'function' ||
      typeof stream.destroy !== 'function') {
    throw new TypeError('Transfer bootstrap requires a Node Duplex stream');
  }
  if (stream.destroyed || stream.readable === false || stream.writable === false) {
    throw new Error('Transfer bootstrap stream is not open for reading and writing');
  }
  if (stream.readableObjectMode || stream.writableObjectMode) {
    throw new TypeError('Transfer bootstrap stream must use byte mode');
  }
  if (stream.listenerCount('data') !== 0 || stream.listenerCount('readable') !== 0) {
    throw new Error('Transfer bootstrap requires exclusive readable stream ownership');
  }
}

function requireIdentity(value, subject) {
  if (!value || typeof value !== 'object') throw new TypeError(`${subject} is required`);
  if (typeof value.deviceId !== 'string' || !DEVICE_ID_PATTERN.test(value.deviceId)) {
    throw new TypeError(`${subject} device ID must be 16 lowercase hexadecimal characters`);
  }
  return value;
}

function readClock(clock) {
  const value = clock();
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError('Transfer bootstrap clock must return a positive safe integer');
  }
  return value;
}

function normalizeError(error) {
  return error instanceof Error ? error : new Error(String(error));
}

function assertPlainObject(value, subject) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new TypeError(`${subject} must be a plain object`);
  }
}

function assertExactKeys(value, required, optional, subject) {
  const allowed = new Set([...required, ...optional]);
  for (const key of required) {
    if (!Object.hasOwn(value, key)) throw new TypeError(`${subject} is missing ${key}`);
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new TypeError(`${subject} contains unknown field ${key}`);
  }
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  bootstrapOutgoingTransfer
};

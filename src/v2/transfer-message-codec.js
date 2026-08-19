'use strict';

const { TextDecoder } = require('util');
const { APP_ID, PROTOCOL_VERSION, MESSAGE_TYPES } = require('./constants');
const { canonicalJson, parseCanonicalJson } = require('./canonical-json');
const {
  MAX_FILE_SIZE_BYTES,
  MAX_TOTAL_SIZE_BYTES,
  MAX_TRANSFER_FILES,
  assertValidRelativePath,
  assertValidTaskId,
  normalizeTransferManifest
} = require('./transfer-manifest');
const { MAX_SEQUENCE } = require('./transfer-session-crypto');

const TYPE_TRANSFER_MANIFEST = MESSAGE_TYPES.TRANSFER_MANIFEST;
const TYPE_TRANSFER_DECISION = MESSAGE_TYPES.TRANSFER_DECISION;
const TYPE_TRANSFER_COMPLETE = MESSAGE_TYPES.TRANSFER_COMPLETE;
const TYPE_TRANSFER_RESUME = MESSAGE_TYPES.TRANSFER_RESUME;
const TYPE_TRANSFER_PROGRESS = MESSAGE_TYPES.TRANSFER_PROGRESS;
const MAX_TRANSFER_MESSAGE_BYTES = 4 * 1024 * 1024;
const MAX_MESSAGE_TTL_MS = 5 * 60 * 1000;
const MAX_CLOCK_SKEW_MS = 30 * 1000;
const MAX_CONTROL_MESSAGE_BYTES = 1024 * 1024;
const MAX_RESUME_ENTRIES = MAX_TRANSFER_FILES;
const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;

const DEVICE_ID_PATTERN = /^[a-f0-9]{16}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const SIGNATURE_PLACEHOLDER = Buffer.alloc(64).toString('base64url');
const DECISIONS = new Set([
  'accepted',
  'rejected',
  'busy',
  'unauthorized',
  'invalid-manifest',
  'expired',
  'unsupported'
]);
const COMPLETION_DIAGNOSTICS = new Set([
  'success',
  'hash-mismatch',
  'size-mismatch',
  'sequence-mismatch',
  'cancelled',
  'io-error',
  'protocol-error'
]);
const TRANSFER_TYPES = new Set([
  TYPE_TRANSFER_MANIFEST,
  TYPE_TRANSFER_DECISION,
  TYPE_TRANSFER_COMPLETE,
  TYPE_TRANSFER_RESUME,
  TYPE_TRANSFER_PROGRESS
]);
const utf8Decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function encodeTransferMessage(type, message, options = {}) {
  assertTransferType(type);
  const normalized = validateTransferMessage(type, message, options);
  const encoded = Buffer.from(canonicalJson(normalized), 'utf8');
  assertPayloadBounds(type, encoded.length);
  return encoded;
}

function decodeTransferMessage(type, payload, options = {}) {
  assertTransferType(type);
  if (!Buffer.isBuffer(payload) && !(payload instanceof Uint8Array)) {
    throw new TypeError('Transfer message payload must be bytes');
  }
  const bytes = Buffer.from(payload);
  assertPayloadBounds(type, bytes.length);
  const text = utf8Decoder.decode(bytes);
  const parsed = parseCanonicalJson(text, 'Transfer message payload');
  const normalized = validateTransferMessage(type, parsed, options);
  if (canonicalJson(normalized) !== text) {
    throw new SyntaxError('Transfer message payload is not in normalized canonical form');
  }
  return normalized;
}

function transferMessageSigningPayload(type, message) {
  assertTransferType(type);
  assertPlainObject(message, 'Transfer message');

  const candidate = { ...message };
  if (!Object.hasOwn(candidate, 'signature')) {
    candidate.signature = SIGNATURE_PLACEHOLDER;
  }

  // Signature bytes are deliberately excluded. Using issuedAt as the validation
  // clock keeps the payload stable after expiry while still enforcing TTL shape.
  const normalized = validateTransferMessage(type, candidate, { now: candidate.issuedAt });
  const unsigned = { ...normalized };
  delete unsigned.signature;
  return canonicalJson(unsigned);
}

function validateTransferMessage(type, message, options = {}) {
  assertTransferType(type);
  assertPlainObject(message, 'Transfer message');
  if (Object.hasOwn(options, 'previous')) {
    throw new TypeError('Transfer control validation requires a complete checkpoint, not options.previous');
  }
  const now = normalizeNow(options.now);

  switch (type) {
    case TYPE_TRANSFER_MANIFEST:
      return validateManifestEnvelope(message, now);
    case TYPE_TRANSFER_DECISION:
      return validateDecision(message, now);
    case TYPE_TRANSFER_COMPLETE:
      return validateComplete(message, now);
    case TYPE_TRANSFER_RESUME:
      return validateResume(message, now, options.checkpoint);
    case TYPE_TRANSFER_PROGRESS:
      return validateProgress(message, now, options.checkpoint);
    default:
      throw new TypeError('Unsupported transfer message type');
  }
}

function validateManifestEnvelope(message, now) {
  assertExactKeys(message, [
    'app',
    'protocolVersion',
    'type',
    'manifest',
    'senderDeviceId',
    'receiverDeviceId',
    'senderEphemeralPublicKey',
    'issuedAt',
    'expiresAt',
    'signature'
  ], 'Transfer manifest envelope');
  assertProtocolEnvelope(message, TYPE_TRANSFER_MANIFEST, 'Transfer manifest envelope');
  const manifest = normalizeTransferManifest(message.manifest);
  assertRoute(message.senderDeviceId, message.receiverDeviceId);
  assertCanonicalBase64Url(message.senderEphemeralPublicKey, 32, 'Sender ephemeral public key');
  assertTimeWindow(message.issuedAt, message.expiresAt, now);
  assertCanonicalBase64Url(message.signature, 64, 'Transfer message signature');

  return {
    app: APP_ID,
    protocolVersion: PROTOCOL_VERSION,
    type: TYPE_TRANSFER_MANIFEST,
    manifest,
    senderDeviceId: message.senderDeviceId,
    receiverDeviceId: message.receiverDeviceId,
    senderEphemeralPublicKey: message.senderEphemeralPublicKey,
    issuedAt: message.issuedAt,
    expiresAt: message.expiresAt,
    signature: message.signature
  };
}

function validateDecision(message, now) {
  assertExactKeys(message, [
    'app',
    'protocolVersion',
    'type',
    'taskId',
    'senderDeviceId',
    'receiverDeviceId',
    'decision',
    'issuedAt',
    'expiresAt',
    'signature'
  ], 'Transfer decision');
  assertProtocolEnvelope(message, TYPE_TRANSFER_DECISION, 'Transfer decision');
  assertValidTaskId(message.taskId);
  assertRoute(message.senderDeviceId, message.receiverDeviceId);
  if (typeof message.decision !== 'string' || !DECISIONS.has(message.decision)) {
    throw new TypeError('Transfer decision diagnostic is unsupported');
  }
  assertTimeWindow(message.issuedAt, message.expiresAt, now);
  assertCanonicalBase64Url(message.signature, 64, 'Transfer message signature');

  return {
    app: APP_ID,
    protocolVersion: PROTOCOL_VERSION,
    type: TYPE_TRANSFER_DECISION,
    taskId: message.taskId,
    senderDeviceId: message.senderDeviceId,
    receiverDeviceId: message.receiverDeviceId,
    decision: message.decision,
    issuedAt: message.issuedAt,
    expiresAt: message.expiresAt,
    signature: message.signature
  };
}

function validateComplete(message, now) {
  assertExactKeys(message, [
    'app',
    'protocolVersion',
    'type',
    'taskId',
    'senderDeviceId',
    'receiverDeviceId',
    'status',
    'diagnostic',
    'sha256',
    'bytes',
    'sequence',
    'issuedAt',
    'expiresAt',
    'signature'
  ], 'Transfer completion');
  assertProtocolEnvelope(message, TYPE_TRANSFER_COMPLETE, 'Transfer completion');
  assertValidTaskId(message.taskId);
  assertRoute(message.senderDeviceId, message.receiverDeviceId);
  if (message.status !== 'success' && message.status !== 'failed') {
    throw new TypeError('Transfer completion status must be success or failed');
  }
  if (typeof message.diagnostic !== 'string' || !COMPLETION_DIAGNOSTICS.has(message.diagnostic)) {
    throw new TypeError('Transfer completion diagnostic is unsupported');
  }
  if (message.status === 'success') {
    if (message.diagnostic !== 'success') {
      throw new TypeError('Successful transfer completion must use the success diagnostic');
    }
    assertSha256(message.sha256);
  } else {
    if (message.diagnostic === 'success') {
      throw new TypeError('Failed transfer completion must use a failure diagnostic');
    }
    if (message.sha256 !== null) {
      throw new TypeError('Failed transfer completion must not claim a verified SHA-256');
    }
  }
  assertNonNegativeSafeInteger(message.bytes, 'Transfer completion byte count');
  assertNonNegativeSafeInteger(message.sequence, 'Transfer completion sequence');
  assertTimeWindow(message.issuedAt, message.expiresAt, now);
  assertCanonicalBase64Url(message.signature, 64, 'Transfer message signature');

  return {
    app: APP_ID,
    protocolVersion: PROTOCOL_VERSION,
    type: TYPE_TRANSFER_COMPLETE,
    taskId: message.taskId,
    senderDeviceId: message.senderDeviceId,
    receiverDeviceId: message.receiverDeviceId,
    status: message.status,
    diagnostic: message.diagnostic,
    sha256: message.sha256,
    bytes: message.bytes,
    sequence: message.sequence,
    issuedAt: message.issuedAt,
    expiresAt: message.expiresAt,
    signature: message.signature
  };
}


function validateResume(message, now, checkpoint) {
  assertExactKeys(message, [
    'app',
    'protocolVersion',
    'type',
    'taskId',
    'senderDeviceId',
    'receiverDeviceId',
    'manifestHash',
    'files',
    'nextSequence',
    'totalTransferred',
    'issuedAt',
    'expiresAt',
    'signature'
  ], 'Transfer resume');
  assertProtocolEnvelope(message, TYPE_TRANSFER_RESUME, 'Transfer resume');
  assertValidTaskId(message.taskId);
  assertRoute(message.senderDeviceId, message.receiverDeviceId);
  assertManifestHash(message.manifestHash);
  const files = normalizeResumeFiles(message.files);
  assertSequence(message.nextSequence, 'Transfer resume next sequence');
  assertNonNegativeSafeInteger(message.totalTransferred, 'Transfer resume total transferred');
  if (message.totalTransferred > MAX_TOTAL_SIZE_BYTES) {
    throw new RangeError('Transfer resume total transferred exceeds the maximum transfer size');
  }
  const committedTotal = files.reduce(
    (total, file) => checkedAdd(total, file.committedOffset, 'Transfer resume committed total'),
    0
  );
  if (message.totalTransferred !== committedTotal) {
    throw new TypeError('Transfer resume total transferred must equal the sum of committed offsets');
  }
  assertTimeWindow(message.issuedAt, message.expiresAt, now);
  assertCanonicalBase64Url(message.signature, 64, 'Transfer message signature');

  const normalized = {
    app: APP_ID,
    protocolVersion: PROTOCOL_VERSION,
    type: TYPE_TRANSFER_RESUME,
    taskId: message.taskId,
    senderDeviceId: message.senderDeviceId,
    receiverDeviceId: message.receiverDeviceId,
    manifestHash: message.manifestHash,
    files,
    nextSequence: message.nextSequence,
    totalTransferred: message.totalTransferred,
    issuedAt: message.issuedAt,
    expiresAt: message.expiresAt,
    signature: message.signature
  };
  assertMonotonicControl(checkpoint, normalized);
  return normalized;
}

function validateProgress(message, now, checkpoint) {
  assertExactKeys(message, [
    'app',
    'protocolVersion',
    'type',
    'taskId',
    'senderDeviceId',
    'receiverDeviceId',
    'manifestHash',
    'path',
    'fileSize',
    'committedOffset',
    'nextSequence',
    'totalTransferred',
    'issuedAt',
    'expiresAt',
    'signature'
  ], 'Transfer progress acknowledgement');
  assertProtocolEnvelope(message, TYPE_TRANSFER_PROGRESS, 'Transfer progress acknowledgement');
  assertValidTaskId(message.taskId);
  assertRoute(message.senderDeviceId, message.receiverDeviceId);
  assertManifestHash(message.manifestHash);
  assertValidRelativePath(message.path);
  assertBoundedFileSize(message.fileSize, 'Transfer progress file size');
  assertNonNegativeSafeInteger(message.committedOffset, 'Transfer progress committed offset');
  if (message.committedOffset > message.fileSize) {
    throw new RangeError('Transfer progress committed offset exceeds the file size');
  }
  assertSequence(message.nextSequence, 'Transfer progress next sequence');
  assertNonNegativeSafeInteger(message.totalTransferred, 'Transfer progress total transferred');
  if (message.totalTransferred < message.committedOffset || message.totalTransferred > MAX_TOTAL_SIZE_BYTES) {
    throw new RangeError('Transfer progress total transferred is outside the accepted bounds');
  }
  assertTimeWindow(message.issuedAt, message.expiresAt, now);
  assertCanonicalBase64Url(message.signature, 64, 'Transfer message signature');

  const normalized = {
    app: APP_ID,
    protocolVersion: PROTOCOL_VERSION,
    type: TYPE_TRANSFER_PROGRESS,
    taskId: message.taskId,
    senderDeviceId: message.senderDeviceId,
    receiverDeviceId: message.receiverDeviceId,
    manifestHash: message.manifestHash,
    path: message.path,
    fileSize: message.fileSize,
    committedOffset: message.committedOffset,
    nextSequence: message.nextSequence,
    totalTransferred: message.totalTransferred,
    issuedAt: message.issuedAt,
    expiresAt: message.expiresAt,
    signature: message.signature
  };
  assertMonotonicControl(checkpoint, normalized);
  return normalized;
}

function normalizeResumeFiles(files) {
  if (!Array.isArray(files) || files.length === 0 || files.length > MAX_RESUME_ENTRIES) {
    throw new RangeError('Transfer resume files must be a bounded array');
  }
  const seenPaths = new Set();
  const seenWindowsPaths = new Set();
  const normalized = files.map((file) => {
    assertPlainObject(file, 'Transfer resume file');
    assertExactKeys(file, ['path', 'size', 'committedOffset'], 'Transfer resume file');
    assertValidRelativePath(file.path);
    const windowsPath = file.path.split('/').map((component) => component.toUpperCase()).join('/');
    if (seenPaths.has(file.path) || seenWindowsPaths.has(windowsPath)) {
      throw new TypeError(`Transfer resume contains a duplicate path: ${file.path}`);
    }
    seenPaths.add(file.path);
    seenWindowsPaths.add(windowsPath);
    assertBoundedFileSize(file.size, 'Transfer resume file size');
    assertNonNegativeSafeInteger(file.committedOffset, 'Transfer resume committed offset');
    if (file.committedOffset > file.size) {
      throw new RangeError('Transfer resume committed offset exceeds the file size');
    }
    return { path: file.path, size: file.size, committedOffset: file.committedOffset };
  });
  normalized.sort((left, right) => compareCodeUnits(left.path, right.path));
  return normalized;
}

function assertMonotonicControl(checkpoint, next) {
  if (checkpoint === undefined || checkpoint === null) return;
  const normalizedPrevious = normalizeControlCheckpoint(checkpoint);
  for (const key of ['taskId', 'senderDeviceId', 'receiverDeviceId', 'manifestHash']) {
    if (normalizedPrevious[key] !== next[key]) {
      throw new TypeError(`Transfer control message changed bound field ${key}`);
    }
  }
  if (next.nextSequence < normalizedPrevious.nextSequence) {
    throw new RangeError('Transfer control next sequence must not move backwards');
  }
  if (next.totalTransferred < normalizedPrevious.totalTransferred) {
    throw new RangeError('Transfer control total transferred must not move backwards');
  }
  if (next.issuedAt < normalizedPrevious.issuedAt) {
    throw new RangeError('Transfer control issue time must not move backwards');
  }

  const previousOffsets = new Map(normalizedPrevious.files.map((file) => [file.path, file]));
  const nextOffsets = controlOffsets(next);
  if (next.type === TYPE_TRANSFER_PROGRESS && !previousOffsets.has(next.path)) {
    throw new TypeError(`Transfer progress references a file outside the resume set: ${next.path}`);
  }
  let committedDelta = 0;
  let changedFiles = 0;
  for (const [path, prior] of previousOffsets) {
    const current = nextOffsets.get(path);
    if (!current) {
      if (next.type === TYPE_TRANSFER_RESUME) {
        throw new TypeError(`Transfer resume dropped a previously tracked file: ${path}`);
      }
      continue;
    }
    if (current.size !== prior.size) {
      throw new TypeError(`Transfer control file size changed for ${path}`);
    }
    if (current.committedOffset < prior.committedOffset) {
      throw new RangeError(`Transfer control committed offset moved backwards for ${path}`);
    }
    const delta = current.committedOffset - prior.committedOffset;
    committedDelta = checkedAdd(committedDelta, delta, 'Transfer control committed delta');
    if (delta > 0) changedFiles += 1;
  }
  if (next.type === TYPE_TRANSFER_RESUME && previousOffsets.size !== nextOffsets.size) {
    throw new TypeError('Transfer resume file set must remain stable');
  }
  const expectedTotal = checkedAdd(
    normalizedPrevious.totalTransferred,
    committedDelta,
    'Transfer control total transferred'
  );
  if (next.totalTransferred !== expectedTotal) {
    throw new TypeError('Transfer control total transferred must equal the checkpoint plus committed offset delta');
  }
  const sequenceDelta = next.nextSequence - normalizedPrevious.nextSequence;
  if (sequenceDelta < changedFiles) {
    throw new RangeError('Transfer control next sequence delta is too small for the changed files');
  }
}

function normalizeControlCheckpoint(checkpoint) {
  assertPlainObject(checkpoint, 'Transfer control checkpoint');
  assertExactKeys(checkpoint, [
    'taskId',
    'senderDeviceId',
    'receiverDeviceId',
    'manifestHash',
    'files',
    'nextSequence',
    'totalTransferred',
    'issuedAt'
  ], 'Transfer control checkpoint');
  assertValidTaskId(checkpoint.taskId);
  assertRoute(checkpoint.senderDeviceId, checkpoint.receiverDeviceId);
  assertManifestHash(checkpoint.manifestHash);
  const files = normalizeResumeFiles(checkpoint.files);
  assertSequence(checkpoint.nextSequence, 'Transfer control checkpoint next sequence');
  assertNonNegativeSafeInteger(checkpoint.totalTransferred, 'Transfer control checkpoint total transferred');
  const committedTotal = files.reduce(
    (total, file) => checkedAdd(total, file.committedOffset, 'Transfer control checkpoint committed total'),
    0
  );
  if (checkpoint.totalTransferred !== committedTotal) {
    throw new TypeError('Transfer control checkpoint total transferred must equal the sum of committed offsets');
  }
  assertPositiveSafeInteger(checkpoint.issuedAt, 'Transfer control checkpoint issuedAt');
  return {
    taskId: checkpoint.taskId,
    senderDeviceId: checkpoint.senderDeviceId,
    receiverDeviceId: checkpoint.receiverDeviceId,
    manifestHash: checkpoint.manifestHash,
    files,
    nextSequence: checkpoint.nextSequence,
    totalTransferred: checkpoint.totalTransferred,
    issuedAt: checkpoint.issuedAt
  };
}

function controlOffsets(message) {
  if (message.type === TYPE_TRANSFER_RESUME) {
    return new Map(message.files.map((file) => [file.path, file]));
  }
  return new Map([[message.path, {
    path: message.path,
    size: message.fileSize,
    committedOffset: message.committedOffset
  }]]);
}

function advanceTransferControlCheckpoint(type, message, options = {}) {
  if (type !== TYPE_TRANSFER_RESUME && type !== TYPE_TRANSFER_PROGRESS) {
    throw new TypeError('Only transfer resume and progress messages can advance a control checkpoint');
  }
  const previous = options.checkpoint === undefined || options.checkpoint === null
    ? null
    : normalizeControlCheckpoint(options.checkpoint);
  if (previous === null && type !== TYPE_TRANSFER_RESUME) {
    throw new TypeError('The first transfer control checkpoint must be created from a transfer resume message');
  }
  const normalized = validateTransferMessage(type, message, {
    now: options.now,
    checkpoint: previous
  });
  const files = previous === null
    ? normalized.files
    : normalized.type === TYPE_TRANSFER_RESUME
      ? normalized.files
      : previous.files.map((file) => file.path === normalized.path
        ? { path: file.path, size: file.size, committedOffset: normalized.committedOffset }
        : file);
  return normalizeControlCheckpoint({
    taskId: normalized.taskId,
    senderDeviceId: normalized.senderDeviceId,
    receiverDeviceId: normalized.receiverDeviceId,
    manifestHash: normalized.manifestHash,
    files,
    nextSequence: normalized.nextSequence,
    totalTransferred: normalized.totalTransferred,
    issuedAt: normalized.issuedAt
  });
}

function assertManifestHash(value) {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    throw new TypeError('Transfer manifest hash must be 64 lowercase hexadecimal characters');
  }
}

function assertBoundedFileSize(value, label) {
  assertNonNegativeSafeInteger(value, label);
  if (value > MAX_FILE_SIZE_BYTES) {
    throw new RangeError(`${label} exceeds the maximum file size`);
  }
}

function compareCodeUnits(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function checkedAdd(left, right, label) {
  if (left > MAX_SAFE_INTEGER - right) {
    throw new RangeError(`${label} exceeds safe integer precision`);
  }
  return left + right;
}

function assertProtocolEnvelope(message, expectedType, label) {
  if (message.app !== APP_ID || message.protocolVersion !== PROTOCOL_VERSION || message.type !== expectedType) {
    throw new TypeError(`${label} protocol envelope is invalid`);
  }
}

function assertRoute(senderDeviceId, receiverDeviceId) {
  assertDeviceId(senderDeviceId, 'Sender device ID');
  assertDeviceId(receiverDeviceId, 'Receiver device ID');
  if (senderDeviceId === receiverDeviceId) {
    throw new TypeError('Transfer message sender and receiver must differ');
  }
}

function assertDeviceId(value, label) {
  if (typeof value !== 'string' || !DEVICE_ID_PATTERN.test(value)) {
    throw new TypeError(`${label} must be 16 lowercase hexadecimal characters`);
  }
}

function assertSha256(value) {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    throw new TypeError('Transfer completion SHA-256 must be 64 lowercase hexadecimal characters');
  }
}

function assertCanonicalBase64Url(value, expectedBytes, label) {
  if (typeof value !== 'string' || !BASE64URL_PATTERN.test(value)) {
    throw new TypeError(`${label} must use unpadded base64url`);
  }
  let decoded;
  try {
    decoded = Buffer.from(value, 'base64url');
  } catch (_) {
    throw new TypeError(`${label} must be valid base64url`);
  }
  if (decoded.length !== expectedBytes || decoded.toString('base64url') !== value) {
    throw new TypeError(`${label} must be canonical base64url for ${expectedBytes} bytes`);
  }
}

function assertTimeWindow(issuedAt, expiresAt, now) {
  assertPositiveSafeInteger(issuedAt, 'Transfer message issuedAt');
  assertPositiveSafeInteger(expiresAt, 'Transfer message expiresAt');
  if (expiresAt <= issuedAt || expiresAt - issuedAt > MAX_MESSAGE_TTL_MS) {
    throw new RangeError('Transfer message expiration window is invalid');
  }
  if (issuedAt > now && issuedAt - now > MAX_CLOCK_SKEW_MS) {
    throw new RangeError('Transfer message issue time is too far in the future');
  }
  if (expiresAt < now) {
    throw new RangeError('Transfer message has expired');
  }
}

function normalizeNow(value) {
  const now = value === undefined ? Date.now() : value;
  assertPositiveSafeInteger(now, 'Transfer message validation time');
  return now;
}

function assertPositiveSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_SAFE_INTEGER) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
}

function assertSequence(value, label) {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_SEQUENCE) {
    throw new TypeError(`${label} must be between 0 and the transfer crypto maximum sequence`);
  }
}

function assertNonNegativeSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_SAFE_INTEGER) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
}

function assertPlainObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new TypeError(`${label} must be a plain object`);
  }
}

function assertExactKeys(value, expected, label) {
  const expectedSet = new Set(expected);
  for (const key of expected) {
    if (!Object.hasOwn(value, key)) throw new TypeError(`${label} is missing ${key}`);
  }
  for (const key of Object.keys(value)) {
    if (!expectedSet.has(key)) throw new TypeError(`${label} contains unknown field ${key}`);
  }
}

function assertPayloadBounds(type, length) {
  const maximum = type === TYPE_TRANSFER_RESUME || type === TYPE_TRANSFER_PROGRESS
    ? MAX_CONTROL_MESSAGE_BYTES
    : MAX_TRANSFER_MESSAGE_BYTES;
  if (!Number.isSafeInteger(length) || length <= 0 || length > maximum) {
    throw new RangeError('Transfer message payload exceeds the accepted bounds');
  }
}

function assertTransferType(type) {
  if (typeof type !== 'string' || !TRANSFER_TYPES.has(type)) {
    throw new TypeError('Unsupported transfer message type');
  }
}

module.exports = {
  COMPLETION_DIAGNOSTICS,
  DECISIONS,
  MAX_CLOCK_SKEW_MS,
  MAX_CONTROL_MESSAGE_BYTES,
  MAX_MESSAGE_TTL_MS,
  MAX_RESUME_ENTRIES,
  MAX_TRANSFER_MESSAGE_BYTES,
  TYPE_TRANSFER_COMPLETE,
  TYPE_TRANSFER_DECISION,
  TYPE_TRANSFER_MANIFEST,
  TYPE_TRANSFER_PROGRESS,
  TYPE_TRANSFER_RESUME,
  advanceTransferControlCheckpoint,
  decodeTransferMessage,
  encodeTransferMessage,
  transferMessageSigningPayload,
  validateTransferMessage
};

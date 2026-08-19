'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const util = require('util');
const { normalizeTransferManifest } = require('./transfer-manifest');
const {
  KEY_BYTES,
  MAX_CHUNK_BYTES,
  MAX_SEQUENCE,
  encryptChunk
} = require('./transfer-session-crypto');

const DEFAULT_CHUNK_SIZE = 256 * 1024;
const READ_OPEN_FLAGS = fs.constants.O_RDONLY |
  (typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0);
const SOURCE_FILE_KEYS = ['path', 'sha256', 'size', 'sourcePath'];
const INPUT_KEYS = [
  'chunkSize',
  'manifest',
  'resumeOffsets',
  'sessionKey',
  'signal',
  'sourceFiles',
  'startSequence'
];

function createEncryptedChunkReader(input) {
  const config = normalizeInput(input);
  let started = false;
  let released = false;
  const releaseSessionKey = () => {
    if (released) return;
    released = true;
    config.sessionKey.fill(0);
    if (config.signal) config.signal.removeEventListener('abort', releaseSessionKey);
  };

  if (config.signal) {
    config.signal.addEventListener('abort', releaseSessionKey, { once: true });
    if (config.signal.aborted) releaseSessionKey();
  }

  const generator = readEncryptedChunks(config, releaseSessionKey);
  const settle = (operation) => operation.then(
    (result) => {
      if (result.done) releaseSessionKey();
      return result;
    },
    (error) => {
      releaseSessionKey();
      throw error;
    }
  );

  return Object.freeze({
    next(value) {
      started = true;
      return settle(generator.next(value));
    },
    return(value) {
      if (!started) releaseSessionKey();
      return settle(generator.return(value));
    },
    throw(error) {
      if (!started) releaseSessionKey();
      return settle(generator.throw(error));
    },
    [Symbol.asyncIterator]() {
      return this;
    }
  });
}

function normalizeInput(input) {
  assertPlainObject(input, 'Encrypted chunk reader input');
  assertOnlyKeys(input, INPUT_KEYS, 'Encrypted chunk reader input');
  for (const required of ['manifest', 'sourceFiles', 'sessionKey']) {
    if (!Object.prototype.hasOwnProperty.call(input, required)) {
      throw new TypeError(`Encrypted chunk reader input is missing ${required}`);
    }
  }

  const manifest = normalizeTransferManifest(input.manifest);
  if (!util.isDeepStrictEqual(input.manifest, manifest)) {
    throw new TypeError('Transfer manifest must already be normalized');
  }

  assertSessionKey(input.sessionKey);
  const chunkSize = input.chunkSize === undefined ? DEFAULT_CHUNK_SIZE : input.chunkSize;
  assertSafeInteger(chunkSize, 1, MAX_CHUNK_BYTES, 'Encrypted chunk size');
  const startSequence = input.startSequence === undefined ? 0 : input.startSequence;
  assertSafeInteger(startSequence, 0, MAX_SEQUENCE, 'Encrypted chunk starting sequence');
  const signal = normalizeAbortSignal(input.signal);

  const manifestFiles = manifest.entries.filter((entry) => entry.kind === 'file');
  const sourceFiles = normalizeSourceFiles(input.sourceFiles, manifestFiles);
  const resumeOffsets = normalizeResumeOffsets(input.resumeOffsets, manifestFiles);
  assertResumeAlignment(sourceFiles, resumeOffsets, chunkSize);
  assertSequenceCapacity(sourceFiles, resumeOffsets, chunkSize, startSequence);
  const sessionKey = Buffer.from(input.sessionKey);

  return Object.freeze({
    manifest,
    sourceFiles,
    resumeOffsets,
    sessionKey,
    chunkSize,
    startSequence,
    signal
  });
}

async function* readEncryptedChunks(config, releaseSessionKey) {
  let emittedChunks = 0n;
  try {
    throwIfAborted(config.signal);
    for (const source of config.sourceFiles) {
      throwIfAborted(config.signal);
      const resumeOffset = config.resumeOffsets.get(source.path);
      if (resumeOffset === source.size && source.size !== 0) continue;

      let handle;
      let closePromise;
      const closeHandle = () => {
        if (handle && !closePromise) closePromise = handle.close();
        return closePromise;
      };
      const onAbort = () => {
        releaseSessionKey();
        const pendingClose = closeHandle();
        if (pendingClose) void pendingClose.catch(() => {});
      };

      try {
        const pathSnapshot = await readPathSnapshot(source.sourcePath, source.path);
        assertExpectedSize(pathSnapshot, source);
        throwIfAborted(config.signal);

        handle = await openSourceFile(source.sourcePath, source.path);
        if (config.signal) config.signal.addEventListener('abort', onAbort, { once: true });
        throwIfAborted(config.signal);

        const handleSnapshot = await readHandleSnapshot(handle, source.path);
        assertExpectedSize(handleSnapshot, source);
        assertSameIdentity(pathSnapshot, handleSnapshot, source.path);
        assertSameSnapshot(pathSnapshot, handleSnapshot, source.path);

        const sourceHash = crypto.createHash('sha256');
        await hashSourcePrefix(handle, sourceHash, resumeOffset, config.signal, source.path);
        await assertSourceUnchanged(handle, source, pathSnapshot, handleSnapshot);
        throwIfAborted(config.signal);

        let offset = resumeOffset;
        if (source.size === 0) {
          assertExpectedHash(sourceHash, source);
          const sequence = sequenceForChunk(config.startSequence, emittedChunks);
          const encrypted = encryptChunk({
            key: config.sessionKey,
            taskId: config.manifest.taskId,
            path: source.path,
            offset: 0,
            sequence,
            plaintext: Buffer.alloc(0)
          });
          yield createChunk(config.manifest.taskId, source.path, 0, sequence, 0, encrypted);
          emittedChunks += 1n;
        } else {
          while (offset < source.size) {
            throwIfAborted(config.signal);
            await assertSourceUnchanged(handle, source, pathSnapshot, handleSnapshot);

            const plainLength = Math.min(config.chunkSize, source.size - offset);
            const sequence = sequenceForChunk(config.startSequence, emittedChunks);
            const plaintext = Buffer.allocUnsafe(plainLength);
            let encrypted;
            try {
              await readExactly(handle, plaintext, offset, config.signal, source.path);
              await assertSourceUnchanged(handle, source, pathSnapshot, handleSnapshot);
              throwIfAborted(config.signal);
              sourceHash.update(plaintext);
              if (offset + plainLength === source.size) assertExpectedHash(sourceHash, source);
              encrypted = encryptChunk({
                key: config.sessionKey,
                taskId: config.manifest.taskId,
                path: source.path,
                offset,
                sequence,
                plaintext
              });
            } finally {
              plaintext.fill(0);
            }

            yield createChunk(
              config.manifest.taskId,
              source.path,
              offset,
              sequence,
              plainLength,
              encrypted
            );
            offset += plainLength;
            emittedChunks += 1n;
          }
        }

        throwIfAborted(config.signal);
        await assertSourceUnchanged(handle, source, pathSnapshot, handleSnapshot);
      } catch (error) {
        if (config.signal && config.signal.aborted) throw createAbortError(config.signal);
        throw error;
      } finally {
        if (config.signal) config.signal.removeEventListener('abort', onAbort);
        await closeHandle();
      }
    }
  } finally {
    releaseSessionKey();
  }
}

function createChunk(taskId, relativePath, offset, sequence, plainLength, encrypted) {
  let nonce;
  let ciphertext;
  let authTag;
  try {
    nonce = Buffer.from(encrypted.nonce);
    ciphertext = Buffer.from(encrypted.ciphertext);
    authTag = Buffer.from(encrypted.authTag);
  } finally {
    wipeBytes(encrypted.nonce);
    wipeBytes(encrypted.ciphertext);
    wipeBytes(encrypted.authTag);
  }
  return Object.freeze({
    taskId,
    path: relativePath,
    offset,
    sequence,
    plainLength,
    nonce,
    ciphertext,
    authTag
  });
}

function wipeBytes(value) {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) value.fill(0);
}

async function openSourceFile(sourcePath, relativePath) {
  try {
    return await fs.promises.open(sourcePath, READ_OPEN_FLAGS);
  } catch (error) {
    if (error && error.code === 'ELOOP') {
      throw new TypeError(`Symbolic links are not supported transfer sources: ${relativePath}`, { cause: error });
    }
    throw new Error(`Unable to open transfer source: ${relativePath}`, { cause: error });
  }
}

async function hashSourcePrefix(handle, hash, length, signal, relativePath) {
  let position = 0;
  while (position < length) {
    throwIfAborted(signal);
    const buffer = Buffer.allocUnsafe(Math.min(DEFAULT_CHUNK_SIZE, length - position));
    try {
      await readExactly(handle, buffer, position, signal, relativePath);
      hash.update(buffer);
    } finally {
      buffer.fill(0);
    }
    position += buffer.length;
  }
}

function assertExpectedHash(hash, source) {
  const actual = hash.digest('hex');
  if (actual !== source.sha256) {
    throw new Error(`Transfer source content no longer matches its manifest: ${source.path}`);
  }
}

async function readExactly(handle, buffer, position, signal, relativePath) {
  let total = 0;
  while (total < buffer.length) {
    throwIfAborted(signal);
    const { bytesRead } = await handle.read(buffer, total, buffer.length - total, position + total);
    throwIfAborted(signal);
    if (bytesRead === 0) {
      throw new Error(`Transfer source changed while reading: ${relativePath}`);
    }
    total += bytesRead;
  }
}

async function readPathSnapshot(sourcePath, relativePath) {
  let snapshot;
  try {
    snapshot = await fs.promises.lstat(sourcePath, { bigint: true });
  } catch (error) {
    throw new Error(`Unable to inspect transfer source: ${relativePath}`, { cause: error });
  }
  if (snapshot.isSymbolicLink()) {
    throw new TypeError(`Symbolic links are not supported transfer sources: ${relativePath}`);
  }
  if (!snapshot.isFile()) {
    throw new TypeError(`Transfer source must be a regular file: ${relativePath}`);
  }
  return snapshot;
}

async function readHandleSnapshot(handle, relativePath) {
  let snapshot;
  try {
    snapshot = await handle.stat({ bigint: true });
  } catch (error) {
    throw new Error(`Unable to inspect opened transfer source: ${relativePath}`, { cause: error });
  }
  if (!snapshot.isFile()) {
    throw new TypeError(`Transfer source must be a regular file: ${relativePath}`);
  }
  return snapshot;
}

async function assertSourceUnchanged(handle, source, initialPath, initialHandle) {
  const currentHandle = await readHandleSnapshot(handle, source.path);
  const currentPath = await readPathSnapshot(source.sourcePath, source.path);
  assertExpectedSize(currentHandle, source);
  assertExpectedSize(currentPath, source);
  assertSameSnapshot(initialHandle, currentHandle, source.path);
  assertSameSnapshot(initialPath, currentPath, source.path);
  assertSameIdentity(currentHandle, currentPath, source.path);
}

function assertExpectedSize(snapshot, source) {
  if (snapshot.size !== BigInt(source.size)) {
    throw new Error(`Transfer source size no longer matches its manifest: ${source.path}`);
  }
}

function assertSameSnapshot(expected, actual, relativePath) {
  if (expected.size !== actual.size ||
      expected.mtimeNs !== actual.mtimeNs ||
      expected.ctimeNs !== actual.ctimeNs ||
      !sameIdentity(expected, actual)) {
    throw new Error(`Transfer source changed while reading: ${relativePath}`);
  }
}

function assertSameIdentity(expected, actual, relativePath) {
  if (!sameIdentity(expected, actual)) {
    throw new Error(`Transfer source identity changed while reading: ${relativePath}`);
  }
}

function sameIdentity(left, right) {
  const leftHasFileId = left.dev !== 0n || left.ino !== 0n;
  const rightHasFileId = right.dev !== 0n || right.ino !== 0n;
  if (leftHasFileId || rightHasFileId) {
    return left.dev === right.dev && left.ino === right.ino;
  }
  return left.birthtimeNs === right.birthtimeNs;
}

function normalizeSourceFiles(sourceFiles, manifestFiles) {
  if (!Array.isArray(sourceFiles) || sourceFiles.length !== manifestFiles.length) {
    throw new TypeError('Transfer source mapping must contain exactly one record for every manifest file');
  }

  const manifestByPath = new Map(manifestFiles.map((entry) => [entry.path, entry]));
  const sourceByPath = new Map();
  const seenSourcePaths = new Set();
  for (const source of sourceFiles) {
    assertPlainObject(source, 'Transfer source record');
    assertExactKeys(source, SOURCE_FILE_KEYS, 'Transfer source record');
    const manifestEntry = manifestByPath.get(source.path);
    if (!manifestEntry || sourceByPath.has(source.path)) {
      throw new TypeError('Transfer source mapping contains a missing, duplicate, or unknown manifest path');
    }
    if (source.size !== manifestEntry.size || source.sha256 !== manifestEntry.sha256) {
      throw new TypeError(`Transfer source metadata does not match its manifest entry: ${source.path}`);
    }
    if (typeof source.sourcePath !== 'string' || source.sourcePath.length === 0 || !path.isAbsolute(source.sourcePath)) {
      throw new TypeError(`Transfer source path must be absolute: ${source.path}`);
    }
    const sourcePathKey = normalizeFilesystemPath(source.sourcePath);
    if (seenSourcePaths.has(sourcePathKey)) {
      throw new TypeError('Transfer source mapping must not reuse the same filesystem path');
    }
    seenSourcePaths.add(sourcePathKey);
    sourceByPath.set(source.path, Object.freeze({
      path: source.path,
      sourcePath: path.resolve(source.sourcePath),
      size: source.size,
      sha256: source.sha256
    }));
  }

  return Object.freeze(manifestFiles.map((entry) => sourceByPath.get(entry.path)));
}

function normalizeResumeOffsets(resumeOffsets, manifestFiles) {
  if (resumeOffsets === undefined) {
    return new Map(manifestFiles.map((entry) => [entry.path, 0]));
  }
  assertPlainObject(resumeOffsets, 'Transfer resume offsets');
  const manifestByPath = new Map(manifestFiles.map((entry) => [entry.path, entry]));
  const normalized = new Map(manifestFiles.map((entry) => [entry.path, 0]));
  for (const [relativePath, offset] of Object.entries(resumeOffsets)) {
    const manifestEntry = manifestByPath.get(relativePath);
    if (!manifestEntry) {
      throw new TypeError(`Transfer resume offset references an unknown manifest path: ${relativePath}`);
    }
    assertSafeInteger(offset, 0, manifestEntry.size, `Transfer resume offset for ${relativePath}`);
    normalized.set(relativePath, offset);
  }
  return normalized;
}

function assertResumeAlignment(sourceFiles, resumeOffsets, chunkSize) {
  for (const source of sourceFiles) {
    const offset = resumeOffsets.get(source.path);
    if (offset !== source.size && offset % chunkSize !== 0) {
      throw new RangeError(
        `Transfer resume offset for ${source.path} must be chunk-aligned or equal the file size`
      );
    }
  }
}

function assertSequenceCapacity(sourceFiles, resumeOffsets, chunkSize, startSequence) {
  let count = 0n;
  const chunkSizeBigInt = BigInt(chunkSize);
  for (const source of sourceFiles) {
    const remaining = BigInt(source.size - resumeOffsets.get(source.path));
    const fileChunks = source.size === 0
      ? 1n
      : (remaining + chunkSizeBigInt - 1n) / chunkSizeBigInt;
    count += fileChunks;
  }
  if (count > 0n && BigInt(startSequence) + count - 1n > BigInt(MAX_SEQUENCE)) {
    throw new RangeError('Encrypted chunk sequence would exceed the maximum safe integer');
  }
}

function sequenceForChunk(startSequence, emittedChunks) {
  const sequence = BigInt(startSequence) + emittedChunks;
  if (sequence > BigInt(MAX_SEQUENCE)) {
    throw new RangeError('Encrypted chunk sequence exceeds the maximum safe integer');
  }
  return Number(sequence);
}

function assertSessionKey(value) {
  if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) {
    throw new TypeError('Transfer session key must be a Buffer or Uint8Array');
  }
  if (value.byteLength !== KEY_BYTES) {
    throw new RangeError(`Transfer session key must be exactly ${KEY_BYTES} bytes`);
  }
}

function normalizeAbortSignal(signal) {
  if (signal === undefined) return undefined;
  if (!signal || typeof signal !== 'object' || typeof signal.aborted !== 'boolean' ||
      typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function') {
    throw new TypeError('Transfer abort signal must be an AbortSignal');
  }
  return signal;
}

function throwIfAborted(signal) {
  if (signal && signal.aborted) throw createAbortError(signal);
}

function createAbortError(signal) {
  const error = new Error('Encrypted chunk reading was aborted', { cause: signal.reason });
  error.name = 'AbortError';
  return error;
}

function normalizeFilesystemPath(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toUpperCase() : resolved;
}

function assertSafeInteger(value, minimum, maximum, subject) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${subject} must be a safe integer from ${minimum} through ${maximum}`);
  }
}

function assertPlainObject(value, subject) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${subject} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${subject} must be a plain object`);
  }
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !descriptor || !descriptor.enumerable || !('value' in descriptor)) {
      throw new TypeError(`${subject} must contain only enumerable string data properties`);
    }
  }
}

function assertOnlyKeys(value, allowedKeys, subject) {
  const allowed = new Set(allowedKeys);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new TypeError(`${subject} contains unknown fields`);
  }
}

function assertExactKeys(value, expectedKeys, subject) {
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${subject} contains missing or unknown fields`);
  }
}

module.exports = {
  DEFAULT_CHUNK_SIZE,
  createEncryptedChunkReader
};

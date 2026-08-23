/**
 * Streaming reader that produces encrypted transfer chunks from local source
 * files. Ported from src/v2/encrypted-chunk-reader.js.
 *
 * Reads each source file in fixed-size chunks, encrypts every chunk with the
 * session key, and yields one chunk frame per read. Detects TOCTOU file changes
 * by comparing stat snapshots (size/mtime/ctime/dev/ino) taken before opening,
 * after opening, and repeatedly while reading. Supports abort signals and
 * resume from a checkpoint or legacy offsets/sequence.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import util from 'node:util';
import { Buffer } from 'node:buffer';
import { normalizeTransferManifest, type TransferManifest, type ManifestFileEntry } from './manifest.js';
import { KEY_BYTES, MAX_CHUNK_BYTES, MAX_SEQUENCE, encryptChunk, type EncryptedChunk } from '../crypto/session.js';
import type { ChunkFrameInput } from './chunk-frame.js';

export const DEFAULT_CHUNK_SIZE = 256 * 1024;
const READ_OPEN_FLAGS = fs.constants.O_RDONLY |
  (typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0);
const SOURCE_FILE_KEYS = ['path', 'sha256', 'size', 'sourcePath'];
const INPUT_KEYS = [
  'chunkSize',
  'manifest',
  'resumeCheckpoint',
  'resumeOffsets',
  'sessionKey',
  'signal',
  'sourceFiles',
  'startSequence',
];

interface SourceRecord {
  readonly path: string;
  readonly sourcePath: string;
  readonly size: number;
  readonly sha256: string;
}

interface ResumeFileEntry {
  readonly path: string;
  readonly size: number;
  readonly committedOffset: number;
  readonly completed: boolean;
}

interface ResumeCheckpoint {
  readonly files: ReadonlyMap<string, ResumeFileEntry>;
  readonly nextSequence: number;
  readonly totalTransferred: number;
}

interface ResumeState {
  readonly files: ReadonlyMap<string, ResumeFileEntry>;
  readonly nextSequence: number;
}

interface ReaderConfig {
  readonly manifest: TransferManifest;
  readonly sourceFiles: readonly SourceRecord[];
  readonly resumeFiles: ReadonlyMap<string, ResumeFileEntry>;
  readonly sessionKey: Buffer;
  readonly chunkSize: number;
  readonly startSequence: number;
  readonly signal: AbortSignal | undefined;
}

interface EncryptedChunkReaderInput {
  readonly chunkSize?: number;
  readonly manifest: unknown;
  readonly resumeCheckpoint?: unknown;
  readonly resumeOffsets?: unknown;
  readonly sessionKey: Uint8Array;
  readonly signal?: AbortSignal;
  readonly sourceFiles: unknown;
  readonly startSequence?: number;
}

type StatSnapshot = fs.BigIntStats;
type ReaderResult = IteratorResult<ChunkFrameInput>;

/** Encrypted chunk reader async iterator. */
export interface EncryptedChunkReader extends AsyncIterable<ChunkFrameInput> {
  next(value?: unknown): Promise<ReaderResult>;
  return(value?: unknown): Promise<ReaderResult>;
  throw(error: unknown): Promise<ReaderResult>;
}

export function createEncryptedChunkReader(input: EncryptedChunkReaderInput): EncryptedChunkReader {
  const config = normalizeInput(input);
  let started = false;
  let released = false;
  const releaseSessionKey = (): void => {
    if (released) return;
    released = true;
    config.sessionKey.fill(0);
    if (config.signal) config.signal.removeEventListener('abort', releaseSessionKey);
  };

  if (config.signal) {
    config.signal.addEventListener('abort', releaseSessionKey, { once: true });
    if (config.signal.aborted) releaseSessionKey();
  }

  const generator: AsyncGenerator<ChunkFrameInput, unknown, unknown> = readEncryptedChunks(config, releaseSessionKey);
  const settle = (operation: Promise<ReaderResult>): Promise<ReaderResult> => operation.then(
    (result) => {
      if (result.done) releaseSessionKey();
      return result;
    },
    (error) => {
      releaseSessionKey();
      throw error;
    },
  );

  return Object.freeze({
    next(value?: unknown) {
      started = true;
      return settle(generator.next(value));
    },
    return(value?: unknown) {
      if (!started) releaseSessionKey();
      return settle(generator.return(value));
    },
    throw(error: unknown) {
      if (!started) releaseSessionKey();
      return settle(generator.throw(error));
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  });
}

function normalizeInput(input: EncryptedChunkReaderInput): ReaderConfig {
  assertPlainObject(input, 'Encrypted chunk reader input');
  assertOnlyKeys(input as unknown as Record<string, unknown>, INPUT_KEYS, 'Encrypted chunk reader input');
  for (const required of ['manifest', 'sourceFiles', 'sessionKey'] as const) {
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
  const signal = normalizeAbortSignal(input.signal);

  const manifestFiles = manifest.entries.filter((entry): entry is ManifestFileEntry => entry.kind === 'file');
  const sourceFiles = normalizeSourceFiles(input.sourceFiles, manifestFiles);
  const resume = normalizeResumeState(input, manifestFiles);
  assertResumeAlignment(sourceFiles, resume.files, chunkSize);
  assertSequenceCapacity(sourceFiles, resume.files, chunkSize, resume.nextSequence);
  const sessionKey = Buffer.from(input.sessionKey);

  return Object.freeze({
    manifest,
    sourceFiles,
    resumeFiles: resume.files,
    sessionKey,
    chunkSize,
    startSequence: resume.nextSequence,
    signal,
  });
}

async function* readEncryptedChunks(config: ReaderConfig, releaseSessionKey: () => void): AsyncGenerator<ChunkFrameInput, void, unknown> {
  let emittedChunks = 0n;
  try {
    throwIfAborted(config.signal);
    for (const source of config.sourceFiles) {
      throwIfAborted(config.signal);
      const resume = config.resumeFiles.get(source.path);
      const resumeOffset = resume!.committedOffset;
      if (resume!.completed) continue;

      let handle: fs.promises.FileHandle | undefined;
      let closePromise: Promise<void> | undefined;
      const closeHandle = (): Promise<void> | undefined => {
        if (handle && !closePromise) closePromise = handle.close();
        return closePromise;
      };
      const onAbort = (): void => {
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
            plaintext: Buffer.alloc(0),
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
            let encrypted: EncryptedChunk;
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
                plaintext,
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
              encrypted,
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

function createChunk(
  taskId: string,
  relativePath: string,
  offset: number,
  sequence: number,
  plainLength: number,
  encrypted: EncryptedChunk,
): ChunkFrameInput {
  let nonce: Buffer;
  let ciphertext: Buffer;
  let authTag: Buffer;
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
    relativePath,
    offset,
    sequence,
    plainLength,
    nonce,
    ciphertext,
    authTag,
  });
}

function wipeBytes(value: Uint8Array): void {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) value.fill(0);
}

async function openSourceFile(sourcePath: string, relativePath: string): Promise<fs.promises.FileHandle> {
  try {
    return await fs.promises.open(sourcePath, READ_OPEN_FLAGS);
  } catch (error) {
    if (error && (error as NodeJS.ErrnoException).code === 'ELOOP') {
      throw new TypeError(`Symbolic links are not supported transfer sources: ${relativePath}`, { cause: error });
    }
    throw new Error(`Unable to open transfer source: ${relativePath}`, { cause: error });
  }
}

async function hashSourcePrefix(
  handle: fs.promises.FileHandle,
  hash: crypto.Hash,
  length: number,
  signal: AbortSignal | undefined,
  relativePath: string,
): Promise<void> {
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

function assertExpectedHash(hash: crypto.Hash, source: SourceRecord): void {
  const actual = hash.digest('hex');
  if (actual !== source.sha256) {
    throw new Error(`Transfer source content no longer matches its manifest: ${source.path}`);
  }
}

async function readExactly(
  handle: fs.promises.FileHandle,
  buffer: Buffer,
  position: number,
  signal: AbortSignal | undefined,
  relativePath: string,
): Promise<void> {
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

async function readPathSnapshot(sourcePath: string, relativePath: string): Promise<StatSnapshot> {
  let snapshot: StatSnapshot;
  try {
    snapshot = await fs.promises.lstat(sourcePath, { bigint: true }) as fs.BigIntStats;
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

async function readHandleSnapshot(handle: fs.promises.FileHandle, relativePath: string): Promise<StatSnapshot> {
  let snapshot: StatSnapshot;
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

async function assertSourceUnchanged(
  handle: fs.promises.FileHandle,
  source: SourceRecord,
  initialPath: StatSnapshot,
  initialHandle: StatSnapshot,
): Promise<void> {
  const currentHandle = await readHandleSnapshot(handle, source.path);
  const currentPath = await readPathSnapshot(source.sourcePath, source.path);
  assertExpectedSize(currentHandle, source);
  assertExpectedSize(currentPath, source);
  assertSameSnapshot(initialHandle, currentHandle, source.path);
  assertSameSnapshot(initialPath, currentPath, source.path);
  assertSameIdentity(currentHandle, currentPath, source.path);
}

function assertExpectedSize(snapshot: StatSnapshot, source: SourceRecord): void {
  if (snapshot.size !== BigInt(source.size)) {
    throw new Error(`Transfer source size no longer matches its manifest: ${source.path}`);
  }
}

function assertSameSnapshot(expected: StatSnapshot, actual: StatSnapshot, relativePath: string): void {
  if (expected.size !== actual.size ||
      expected.mtimeNs !== actual.mtimeNs ||
      expected.ctimeNs !== actual.ctimeNs ||
      !sameIdentity(expected, actual)) {
    throw new Error(`Transfer source changed while reading: ${relativePath}`);
  }
}

function assertSameIdentity(expected: StatSnapshot, actual: StatSnapshot, relativePath: string): void {
  if (!sameIdentity(expected, actual)) {
    throw new Error(`Transfer source identity changed while reading: ${relativePath}`);
  }
}

function sameIdentity(left: StatSnapshot, right: StatSnapshot): boolean {
  const leftHasFileId = left.dev !== 0n || left.ino !== 0n;
  const rightHasFileId = right.dev !== 0n || right.ino !== 0n;
  if (leftHasFileId || rightHasFileId) {
    return left.dev === right.dev && left.ino === right.ino;
  }
  return left.birthtimeNs === right.birthtimeNs;
}

function normalizeSourceFiles(sourceFiles: unknown, manifestFiles: readonly ManifestFileEntry[]): readonly SourceRecord[] {
  if (!Array.isArray(sourceFiles) || sourceFiles.length !== manifestFiles.length) {
    throw new TypeError('Transfer source mapping must contain exactly one record for every manifest file');
  }

  const manifestByPath = new Map(manifestFiles.map((entry) => [entry.path, entry]));
  const sourceByPath = new Map<string, SourceRecord>();
  const seenSourcePaths = new Set<string>();
  for (const source of sourceFiles) {
    assertPlainObject(source, 'Transfer source record');
    assertExactKeys(source as Record<string, unknown>, SOURCE_FILE_KEYS, 'Transfer source record');
    const record = source as Record<string, unknown>;
    const manifestEntry = manifestByPath.get(record.path as string);
    if (!manifestEntry || sourceByPath.has(record.path as string)) {
      throw new TypeError('Transfer source mapping contains a missing, duplicate, or unknown manifest path');
    }
    if (record.size !== manifestEntry.size || record.sha256 !== manifestEntry.sha256) {
      throw new TypeError(`Transfer source metadata does not match its manifest entry: ${record.path as string}`);
    }
    const sourcePath = record.sourcePath as unknown;
    if (typeof sourcePath !== 'string' || sourcePath.length === 0 || !path.isAbsolute(sourcePath)) {
      throw new TypeError(`Transfer source path must be absolute: ${record.path as string}`);
    }
    const sourcePathKey = normalizeFilesystemPath(sourcePath);
    if (seenSourcePaths.has(sourcePathKey)) {
      throw new TypeError('Transfer source mapping must not reuse the same filesystem path');
    }
    seenSourcePaths.add(sourcePathKey);
    sourceByPath.set(record.path as string, Object.freeze({
      path: record.path as string,
      sourcePath: path.resolve(sourcePath),
      size: record.size as number,
      sha256: record.sha256 as string,
    }));
  }

  return Object.freeze(manifestFiles.map((entry) => sourceByPath.get(entry.path)!));
}

function normalizeResumeOffsets(resumeOffsets: unknown, manifestFiles: readonly ManifestFileEntry[]): Map<string, number> {
  if (resumeOffsets === undefined) {
    return new Map(manifestFiles.map((entry) => [entry.path, 0]));
  }
  assertPlainObject(resumeOffsets, 'Transfer resume offsets');
  const manifestByPath = new Map(manifestFiles.map((entry) => [entry.path, entry]));
  const normalized = new Map(manifestFiles.map((entry) => [entry.path, 0]));
  for (const [relativePath, offset] of Object.entries(resumeOffsets as Record<string, unknown>)) {
    const manifestEntry = manifestByPath.get(relativePath);
    if (!manifestEntry) {
      throw new TypeError(`Transfer resume offset references an unknown manifest path: ${relativePath}`);
    }
    assertSafeInteger(offset as number, 0, manifestEntry.size, `Transfer resume offset for ${relativePath}`);
    normalized.set(relativePath, offset as number);
  }
  return normalized;
}

function normalizeResumeState(input: EncryptedChunkReaderInput, manifestFiles: readonly ManifestFileEntry[]): ResumeState {
  if (input.resumeCheckpoint !== undefined) {
    if (input.resumeOffsets !== undefined || input.startSequence !== undefined) {
      throw new TypeError('A transfer resume checkpoint cannot be combined with legacy resume fields');
    }
    return normalizeResumeCheckpoint(input.resumeCheckpoint, manifestFiles);
  }

  const offsets = normalizeResumeOffsets(input.resumeOffsets, manifestFiles);
  const nextSequence = input.startSequence === undefined ? 0 : input.startSequence;
  assertSafeInteger(nextSequence, 0, MAX_SEQUENCE, 'Encrypted chunk starting sequence');
  return Object.freeze({
    files: new Map(manifestFiles.map((entry) => {
      const committedOffset = offsets.get(entry.path)!;
      return [entry.path, Object.freeze({
        path: entry.path,
        size: entry.size,
        committedOffset,
        completed: entry.size > 0 && committedOffset === entry.size,
      }) as ResumeFileEntry];
    })),
    nextSequence,
  });
}

function normalizeResumeCheckpoint(checkpoint: unknown, manifestFiles: readonly ManifestFileEntry[]): ResumeState {
  assertPlainObject(checkpoint, 'Transfer resume checkpoint');
  assertExactKeys(checkpoint as Record<string, unknown>, ['files', 'nextSequence', 'totalTransferred'], 'Transfer resume checkpoint');
  const cp = checkpoint as Record<string, unknown>;
  assertSafeInteger(cp.nextSequence as number, 0, MAX_SEQUENCE, 'Transfer resume next sequence');
  assertSafeInteger(cp.totalTransferred as number, 0, Number.MAX_SAFE_INTEGER, 'Transfer resume total transferred');
  const checkpointFiles = cp.files;
  if (!Array.isArray(checkpointFiles) || checkpointFiles.length !== manifestFiles.length) {
    throw new TypeError('Transfer resume checkpoint must contain every manifest file exactly once');
  }

  const manifestByPath = new Map(manifestFiles.map((entry) => [entry.path, entry]));
  const normalized = new Map<string, ResumeFileEntry>();
  let totalTransferred = 0;
  let incompleteSeen = false;
  for (const file of checkpointFiles) {
    assertPlainObject(file, 'Transfer resume checkpoint file');
    assertExactKeys(file as Record<string, unknown>, ['committedOffset', 'completed', 'path', 'size'], 'Transfer resume checkpoint file');
    const f = file as Record<string, unknown>;
    const manifestEntry = manifestByPath.get(f.path as string);
    if (!manifestEntry || normalized.has(f.path as string) || f.size !== manifestEntry.size) {
      throw new TypeError('Transfer resume checkpoint contains a missing, duplicate, unknown, or mismatched file');
    }
    assertSafeInteger(f.committedOffset as number, 0, f.size as number, `Transfer resume offset for ${f.path as string}`);
    if (typeof f.completed !== 'boolean') {
      throw new TypeError(`Transfer resume completion flag for ${f.path as string} must be boolean`);
    }
    if (f.completed && f.committedOffset !== f.size) {
      throw new TypeError(`Transfer resume completion flag for ${f.path as string} conflicts with its committed offset`);
    }
    if (!f.completed && (f.size as number) > 0 && f.committedOffset === f.size) {
      throw new TypeError(`Transfer resume completion flag for ${f.path as string} conflicts with its committed offset`);
    }
    if (incompleteSeen && (f.committedOffset !== 0 || f.completed)) {
      throw new TypeError('Transfer resume checkpoint must describe a contiguous manifest prefix');
    }
    if (!f.completed) incompleteSeen = true;
    totalTransferred += f.committedOffset as number;
    if (!Number.isSafeInteger(totalTransferred)) {
      throw new RangeError('Transfer resume total transferred exceeds safe integer precision');
    }
    normalized.set(f.path as string, Object.freeze({
      path: f.path as string,
      size: f.size as number,
      committedOffset: f.committedOffset as number,
      completed: f.completed,
    }) as ResumeFileEntry);
  }
  if (totalTransferred !== (cp.totalTransferred as number)) {
    throw new TypeError('Transfer resume total transferred does not match its file checkpoints');
  }
  return Object.freeze({ files: normalized, nextSequence: cp.nextSequence as number });
}

function assertResumeAlignment(sourceFiles: readonly SourceRecord[], resumeFiles: ReadonlyMap<string, ResumeFileEntry>, chunkSize: number): void {
  for (const source of sourceFiles) {
    const offset = resumeFiles.get(source.path)!.committedOffset;
    if (offset !== source.size && offset % chunkSize !== 0) {
      throw new RangeError(
        `Transfer resume offset for ${source.path} must be chunk-aligned or equal the file size`,
      );
    }
  }
}

function assertSequenceCapacity(sourceFiles: readonly SourceRecord[], resumeFiles: ReadonlyMap<string, ResumeFileEntry>, chunkSize: number, startSequence: number): void {
  let count = 0n;
  const chunkSizeBigInt = BigInt(chunkSize);
  for (const source of sourceFiles) {
    const resume = resumeFiles.get(source.path)!;
    if (resume.completed) continue;
    const remaining = BigInt(source.size - resume.committedOffset);
    const fileChunks = source.size === 0
      ? 1n
      : (remaining + chunkSizeBigInt - 1n) / chunkSizeBigInt;
    count += fileChunks;
  }
  if (count > 0n && BigInt(startSequence) + count - 1n > BigInt(MAX_SEQUENCE)) {
    throw new RangeError('Encrypted chunk sequence would exceed the maximum safe integer');
  }
}

function sequenceForChunk(startSequence: number, emittedChunks: bigint): number {
  const sequence = BigInt(startSequence) + emittedChunks;
  if (sequence > BigInt(MAX_SEQUENCE)) {
    throw new RangeError('Encrypted chunk sequence exceeds the maximum safe integer');
  }
  return Number(sequence);
}

function assertSessionKey(value: Uint8Array): void {
  if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) {
    throw new TypeError('Transfer session key must be a Buffer or Uint8Array');
  }
  if (value.byteLength !== KEY_BYTES) {
    throw new RangeError(`Transfer session key must be exactly ${KEY_BYTES} bytes`);
  }
}

function normalizeAbortSignal(signal: AbortSignal | undefined): AbortSignal | undefined {
  if (signal === undefined) return undefined;
  if (!signal || typeof signal !== 'object' || typeof signal.aborted !== 'boolean' ||
      typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function') {
    throw new TypeError('Transfer abort signal must be an AbortSignal');
  }
  return signal;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal && signal.aborted) throw createAbortError(signal);
}

function createAbortError(signal: AbortSignal): Error {
  const error = new Error('Encrypted chunk reading was aborted', { cause: signal.reason });
  error.name = 'AbortError';
  return error;
}

function normalizeFilesystemPath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toUpperCase() : resolved;
}

function assertSafeInteger(value: number, minimum: number, maximum: number, subject: string): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${subject} must be a safe integer from ${minimum} through ${maximum}`);
  }
}

function assertPlainObject(value: unknown, subject: string): void {
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

function assertOnlyKeys(value: Record<string, unknown>, allowedKeys: readonly string[], subject: string): void {
  const allowed = new Set(allowedKeys);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new TypeError(`${subject} contains unknown fields`);
  }
}

function assertExactKeys(value: Record<string, unknown>, expectedKeys: readonly string[], subject: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${subject} contains missing or unknown fields`);
  }
}

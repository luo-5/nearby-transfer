/**
 * Encrypted chunk writer: decrypts incoming chunks, writes to staging files,
 * verifies SHA-256, and atomically publishes to final paths.
 * Ported from src/v2/encrypted-chunk-writer.js (811 lines).
 *
 * The writer is async-created and returns a frozen object with writeChunk,
 * complete, cancel, and getCommittedProgress. It manages staging file safety
 * (no symlinks, identity checks), publication via link/rename, and rollback
 * on failure.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import util from 'node:util';
import { Buffer } from 'node:buffer';
import { RESERVATION_ROOT_NAME, STAGING_PREFIX, STAGING_SUFFIX, cleanupReceiveStaging, planReceiveTargets } from './receive-planner.js';
import { normalizeTransferManifest, type TransferManifest, type ManifestEntry } from './manifest.js';
import { KEY_BYTES, MAX_SEQUENCE, decryptChunk } from '../crypto/session.js';

export interface ReceivePlan {
  receiveRoot: string;
  stagingDirectory: string;
  targets: Array<{ path: string; kind: string; stagingPath: string; finalPath: string }>;
  taskId: string;
}

export interface ChunkWriterInput {
  fsPromises?: typeof fs.promises;
  manifest: TransferManifest;
  plan: ReceivePlan;
  resumeProgress?: WriterProgress;
  sessionKey: Uint8Array;
  signal?: AbortSignal;
}

export interface WriterProgress {
  nextSequence: number;
  files: Array<{ path: string; committedOffset: number; completed: boolean }>;
}

export interface WriterCompletion {
  files: number;
  published: true;
  cleanupPending: boolean;
  progress: WriterProgress;
}

export interface EncryptedChunkWriter {
  writeChunk(chunk: WriteChunkInput): Promise<WriterProgress>;
  complete(): Promise<WriterCompletion>;
  cancel(): Promise<WriterProgress>;
  getCommittedProgress(): WriterProgress;
}

export interface WriteChunkInput {
  taskId: string;
  path: string;
  offset: number;
  sequence: number;
  plainLength: number;
  nonce: Uint8Array;
  authTag: Uint8Array;
  ciphertext: Uint8Array;
}

interface FileRecord {
  entry: Extract<ManifestEntry, { kind: 'file' }>;
  target: { path: string; kind: string; stagingPath: string; finalPath: string };
  committedOffset: number;
  completed: boolean;
  identity: { dev: number; ino: number } | null;
}

interface WriterConfig {
  files: FileRecord[];
  fsPromises: typeof fs.promises;
  manifest: TransferManifest;
  nextSequence: number;
  plan: ReceivePlan & { targetByPath: Map<string, FileRecord['target']>; roots: Array<{ sourceRoot: string; stagingPath: string; finalPath: string; kind: string }> };
  resumed: boolean;
  sessionKey: Buffer | null;
  signal: AbortSignal | null;
  currentFileIndex: number;
}

export async function createEncryptedChunkWriter(input: ChunkWriterInput): Promise<EncryptedChunkWriter> {
  const config = normalizeInput(input);
  try {
    if (config.signal && config.signal.aborted) throw createAbortError(config.signal);
    await prepareStaging(config);
  } catch (error) {
    if (config.sessionKey) { config.sessionKey.fill(0); config.sessionKey = null; }
    throw error;
  }

  let state = 'receiving';
  let busy = false;
  let abortRequested = Boolean(config.signal && config.signal.aborted);
  const onAbort = () => { abortRequested = true; if (!busy && state === 'receiving') { state = 'cancelled'; releaseKey(); } };
  if (config.signal) config.signal.addEventListener('abort', onAbort, { once: true });

  function releaseKey(): void {
    if (config.sessionKey) { config.sessionKey.fill(0); config.sessionKey = null; }
    if (config.signal) config.signal.removeEventListener('abort', onAbort);
  }

  function assertReceiving(): void {
    if (state !== 'receiving') throw new Error(`Encrypted chunk writer is ${state}`);
    if (abortRequested) throw createAbortError(config.signal);
  }

  async function runExclusive<T>(operation: () => Promise<T>, terminalOnError = true): Promise<T> {
    if (busy) throw new Error('Concurrent encrypted chunk writer operations are not supported');
    busy = true;
    try {
      assertReceiving();
      return await operation();
    } catch (error) {
      if (terminalOnError && state === 'receiving') { state = abortRequested ? 'cancelled' : 'failed'; releaseKey(); }
      throw error;
    } finally {
      busy = false;
    }
  }

  async function writeChunk(chunk: WriteChunkInput): Promise<WriterProgress> {
    assertPlainDataObject(chunk, 'Transfer chunk');
    return runExclusive(async () => {
      if (chunk.taskId !== config.manifest.taskId) throw new Error('Chunk taskId does not match receive task');
      const record = currentFile(config);
      if (!record) throw new Error('All manifest files are already complete');
      if (chunk.path !== record.entry.path) throw new Error(`Chunk path is out of order; expected ${record.entry.path}`);
      if (chunk.offset !== record.committedOffset) throw new Error(`Chunk offset is not the next committed offset for ${record.entry.path}`);
      if (chunk.sequence !== config.nextSequence) throw new Error('Chunk sequence is duplicated, skipped, or out of order');
      validateChunkBounds(record, chunk);
      const completesFile = record.entry.size === 0 || chunk.offset + chunk.plainLength === record.entry.size;
      const completesTask = completesFile && config.currentFileIndex === config.files.length - 1;
      if (chunk.sequence === MAX_SEQUENCE && !completesTask) throw new RangeError('Chunk sequence space is exhausted before the transfer completes');

      throwIfAborted(abortRequested, config.signal);
      let plaintext: Buffer | null = null;
      try {
        plaintext = decryptChunk({
          key: config.sessionKey!, nonce: chunk.nonce, taskId: chunk.taskId, path: chunk.path,
          offset: chunk.offset, sequence: chunk.sequence, plainLength: chunk.plainLength,
          ciphertext: chunk.ciphertext, authTag: chunk.authTag,
        });
        throwIfAborted(abortRequested, config.signal);
        await commitPlaintext(record, plaintext, config, () => abortRequested);
      } finally {
        if (plaintext) plaintext.fill(0);
      }

      record.committedOffset += chunk.plainLength;
      if (completesFile) {
        try { await verifyCompletedFile(record, config); } catch (error) { await resetUnverifiedFile(record, config); throw error; }
        record.completed = true;
        config.currentFileIndex += 1;
      }
      if (chunk.sequence < MAX_SEQUENCE) config.nextSequence += 1;
      return snapshotProgress(config);
    });
  }

  async function complete(): Promise<WriterCompletion> {
    return runExclusive(async () => {
      if (config.currentFileIndex !== config.files.length) throw new Error('Cannot publish an incomplete transfer task');
      throwIfAborted(abortRequested, config.signal);
      await verifyReadyToPublish(config, () => abortRequested);
      const cleanupPending = await publishAllRoots(config, () => abortRequested);
      state = 'published';
      releaseKey();
      return Object.freeze({ files: config.files.length, published: true as const, cleanupPending, progress: snapshotProgress(config) });
    });
  }

  async function cancel(): Promise<WriterProgress> {
    if (busy) { abortRequested = true; throw new Error('Cannot cancel while an encrypted chunk writer operation is in progress'); }
    if (state === 'published') throw new Error('Cannot cancel a published transfer task');
    if (state === 'cancelled') return snapshotProgress(config);
    if (state !== 'receiving') throw new Error(`Encrypted chunk writer is ${state}`);
    state = 'cancelled';
    releaseKey();
    return snapshotProgress(config);
  }

  function getCommittedProgress(): WriterProgress { return snapshotProgress(config); }

  return Object.freeze({ writeChunk, complete, cancel, getCommittedProgress });
}

function normalizeInput(input: ChunkWriterInput): WriterConfig {
  assertPlainDataObject(input, 'Chunk writer input');
  const manifest = normalizeTransferManifest(input.manifest);
  if (!util.isDeepStrictEqual(input.manifest, manifest)) throw new TypeError('Transfer manifest must already be normalized');
  const fsPromises = input.fsPromises ?? fs.promises;
  const plan = normalizePlan(input.plan, manifest);
  const signal = input.signal ?? null;
  const files: FileRecord[] = manifest.entries
    .filter((e): e is Extract<ManifestEntry, { kind: 'file' }> => e.kind === 'file')
    .map((entry) => ({ entry, target: plan.targetByPath.get(entry.path)!, committedOffset: 0, completed: false, identity: null }));
  const progress = normalizeResumeProgress(input.resumeProgress, files);
  const sessionKey = Buffer.from(input.sessionKey);
  if (sessionKey.length !== KEY_BYTES) throw new TypeError(`Session key must contain exactly ${KEY_BYTES} bytes`);
  for (let i = 0; i < files.length; i++) { files[i]!.committedOffset = progress.files[i]!.committedOffset; files[i]!.completed = progress.files[i]!.completed; }
  const currentFileIndex = (() => { const idx = files.findIndex((f) => !f.completed); return idx === -1 ? files.length : idx; })();
  return { files, fsPromises, manifest, nextSequence: progress.nextSequence, plan, resumed: input.resumeProgress !== undefined, sessionKey, signal, currentFileIndex };
}

function normalizePlan(value: ReceivePlan, manifest: TransferManifest): WriterConfig['plan'] {
  assertPlainDataObject(value, 'Receive target plan');
  if (value.taskId !== manifest.taskId) throw new TypeError('Receive target plan taskId does not match manifest');
  if (typeof value.receiveRoot !== 'string' || !path.isAbsolute(value.receiveRoot)) {
    throw new TypeError('Receive target plan root must be absolute');
  }
  const receiveRoot = path.resolve(value.receiveRoot);
  const expectedStaging = path.join(receiveRoot, `${STAGING_PREFIX}${manifest.taskId}${STAGING_SUFFIX}`);
  if (value.stagingDirectory !== expectedStaging) {
    throw new TypeError('Receive target plan staging directory is not planner-owned');
  }
  if (!Array.isArray(value.targets) || value.targets.length !== manifest.entries.length) {
    throw new TypeError('Receive target plan targets must match manifest entries');
  }

  const targetByPath = new Map<string, FileRecord['target']>();
  for (const target of value.targets) {
    assertPlainDataObject(target, 'Receive target');
    if (targetByPath.has(target.path)) throw new TypeError('Receive target paths must be unique');
    const entry = manifest.entries.find((candidate) => candidate.path === target.path);
    if (!entry || entry.kind !== target.kind) throw new TypeError('Receive target does not match manifest');
    targetByPath.set(target.path, target);
  }

  const roots = manifest.entries.length > 0
    ? Array.from(new Set(manifest.entries.map((e) => e.path.split('/')[0]!))).map((sourceRoot) => ({
        sourceRoot,
        stagingPath: path.join(value.stagingDirectory, sourceRoot),
        finalPath: path.join(value.receiveRoot, sourceRoot),
        kind: manifest.entries.find((e) => e.path === sourceRoot)?.kind ?? 'directory',
      }))
    : [];

  return { ...value, targetByPath, roots };
}

function normalizeResumeProgress(value: WriterProgress | undefined, files: FileRecord[]): WriterProgress {
  if (value === undefined) return { nextSequence: 0, files: files.map((f) => ({ path: f.entry.path, committedOffset: 0, completed: false })) };
  assertPlainDataObject(value, 'Receive resume progress');
  if (!Number.isSafeInteger(value.nextSequence) || value.nextSequence < 0) throw new TypeError('Resume nextSequence must be a safe integer >= 0');
  if (!Array.isArray(value.files) || value.files.length !== files.length) throw new TypeError('Resume progress files count must match manifest');

  let sawIncomplete = false;
  const normalizedFiles = value.files.map((progress, index) => {
    assertPlainDataObject(progress, 'Receive file progress');
    const entry = files[index]!.entry;
    if (progress.path !== entry.path) throw new TypeError('Receive file progress order must match manifest');
    if (!Number.isSafeInteger(progress.committedOffset) || progress.committedOffset < 0 || progress.committedOffset > entry.size) {
      throw new TypeError(`Committed offset for ${entry.path} is invalid`);
    }
    if (typeof progress.completed !== 'boolean') throw new TypeError('Receive file completed flag must be boolean');
    if (progress.completed && progress.committedOffset !== entry.size) {
      throw new TypeError('Completed receive files must have their full committed size');
    }
    if (!progress.completed && entry.size > 0 && progress.committedOffset === entry.size) {
      throw new TypeError('A full-size receive file must be marked completed');
    }
    if (sawIncomplete && (progress.completed || progress.committedOffset !== 0)) {
      throw new TypeError('Receive progress must be a completed prefix followed by at most one partial file');
    }
    if (!progress.completed) sawIncomplete = true;
    return {
      path: progress.path,
      committedOffset: progress.committedOffset,
      completed: progress.completed,
    };
  });
  return { nextSequence: value.nextSequence, files: normalizedFiles };
}

function assertPlainDataObject(value: unknown, subject: string): void {
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

function validateChunkBounds(record: FileRecord, chunk: WriteChunkInput): void {
  if (record.entry.size === 0) { if (chunk.offset !== 0 || chunk.plainLength !== 0 || record.completed) throw new RangeError('Empty files require exactly one zero-length marker chunk'); return; }
  if (chunk.plainLength === 0) throw new RangeError('Non-empty files reject zero-length chunks');
  if (chunk.offset + chunk.plainLength > record.entry.size) throw new RangeError('Chunk exceeds the manifest file size');
}

function currentFile(config: WriterConfig): FileRecord | null {
  return config.currentFileIndex >= config.files.length ? null : config.files[config.currentFileIndex]!;
}

function snapshotProgress(config: WriterConfig): WriterProgress {
  return Object.freeze({ nextSequence: config.nextSequence, files: Object.freeze(config.files.map((r) => Object.freeze({ path: r.entry.path, committedOffset: r.committedOffset, completed: r.completed }))) }) as WriterProgress;
}

async function prepareStaging(config: WriterConfig): Promise<void> {
  for (const record of config.files) {
    const stat = await lstatIfExists(record.target.stagingPath, config.fsPromises);
    if (!config.resumed) { if (stat) throw new Error(`Fresh receive staging file already exists: ${record.entry.path}`); continue; }
    if (!stat) { if (record.committedOffset !== 0 || record.completed) throw new Error(`Committed receive staging file is missing: ${record.entry.path}`); continue; }
    if (stat.isSymbolicLink() || !stat.isFile()) throw new TypeError(`Receive staging target must be a regular file: ${record.entry.path}`);
    if (stat.size < record.committedOffset) throw new Error(`Receive staging file is shorter than committed progress: ${record.entry.path}`);
    if (stat.size !== record.committedOffset) {
      const handle = await config.fsPromises.open(record.target.stagingPath, fs.constants.O_RDWR);
      try {
        await handle.truncate(record.committedOffset);
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
    if (record.completed) await verifyCompletedFile(record, config);
  }
}

async function commitPlaintext(record: FileRecord, plaintext: Buffer, config: WriterConfig, isAborted: () => boolean): Promise<void> {
  await assertSafeDirectoryChain(path.dirname(record.target.stagingPath), config.fsPromises, 'Staging parent');
  let handle: fs.promises.FileHandle | null = null;
  try {
    handle = await openStagingFile(record, config);
    const before = await handle.stat();
    if (before.size < record.committedOffset) throw new Error(`Receive staging file is shorter than committed progress: ${record.entry.path}`);
    if (before.size !== record.committedOffset) { await handle.truncate(record.committedOffset); await handle.sync(); }
    throwIfAborted(isAborted(), config.signal);
    await writeExactly(handle, plaintext, record.committedOffset, isAborted, config.signal);
    throwIfAborted(isAborted(), config.signal);
    await handle.sync();
    record.identity = { dev: before.dev, ino: before.ino };
  } catch (error) {
    if (handle) { await handle.truncate(record.committedOffset).catch(() => {}); await handle.sync().catch(() => {}); }
    throw error;
  } finally {
    if (handle) await handle.close();
  }
}

async function openStagingFile(record: FileRecord, config: WriterConfig): Promise<fs.promises.FileHandle> {
  const existing = await lstatIfExists(record.target.stagingPath, config.fsPromises);
  if (!existing) return config.fsPromises.open(record.target.stagingPath, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
  if (existing.isSymbolicLink() || !existing.isFile()) throw new TypeError(`Receive staging target must be a regular file: ${record.entry.path}`);
  return config.fsPromises.open(record.target.stagingPath, fs.constants.O_RDWR);
}

async function writeExactly(handle: fs.promises.FileHandle, plaintext: Buffer, position: number, isAborted: () => boolean, signal: AbortSignal | null): Promise<void> {
  let written = 0;
  while (written < plaintext.length) {
    throwIfAborted(isAborted(), signal);
    const result = await handle.write(plaintext, written, plaintext.length - written, position + written);
    if (!result || result.bytesWritten <= 0) throw new Error('Receive staging write made no forward progress');
    written += result.bytesWritten;
  }
}

async function resetUnverifiedFile(record: FileRecord, config: WriterConfig): Promise<void> {
  const stat = await lstatIfExists(record.target.stagingPath, config.fsPromises);
  if (stat && stat.isFile() && !stat.isSymbolicLink()) {
    const handle = await config.fsPromises.open(record.target.stagingPath, fs.constants.O_RDWR);
    try { await handle.truncate(0); await handle.sync(); } finally { await handle.close(); }
  }
  record.committedOffset = 0;
  record.completed = false;
}

async function verifyCompletedFile(record: FileRecord, config: WriterConfig): Promise<void> {
  const handle = await config.fsPromises.open(record.target.stagingPath, fs.constants.O_RDONLY);
  try {
    const stat = await handle.stat();
    const hash = crypto.createHash('sha256');
    const buffer = Buffer.allocUnsafe(256 * 1024);
    let offset = 0;
    while (offset < stat.size) {
      const result = await handle.read(buffer, 0, Math.min(buffer.length, stat.size - offset), offset);
      if (result.bytesRead <= 0) throw new Error('Receive staging hash read ended unexpectedly');
      hash.update(buffer.subarray(0, result.bytesRead));
      offset += result.bytesRead;
    }
    const digest = hash.digest('hex');
    if (stat.size !== record.entry.size || digest !== record.entry.sha256) throw new Error(`Completed receive file does not match manifest: ${record.entry.path}`);
  } finally {
    await handle.close();
  }
}

async function assertSafeTreeMatchesPlan(config: WriterConfig): Promise<void> {
  const expected = new Map<string, string>();
  expected.set(config.plan.stagingDirectory, 'directory');
  for (const target of config.plan.targetByPath.values()) expected.set(target.stagingPath, target.kind);

  async function visit(current: string): Promise<void> {
    const stat = await config.fsPromises.lstat(current);
    if (stat.isSymbolicLink()) throw new TypeError('Receive staging tree contains a symbolic link or junction');
    const expectedKind = expected.get(current);
    if (!expectedKind) throw new Error('Receive staging tree contains an unexpected entry');
    if (expectedKind === 'directory') {
      if (!stat.isDirectory()) throw new TypeError('Receive staging tree entry must be a directory');
      const names = await config.fsPromises.readdir(current);
      for (const name of names) await visit(path.join(current, name));
    } else if (!stat.isFile()) {
      throw new TypeError('Receive staging tree entry must be a regular file');
    }
  }
  await visit(config.plan.stagingDirectory);

  for (const [expectedPath, kind] of expected) {
    if (kind === 'directory') continue;
    if (!await lstatIfExists(expectedPath, config.fsPromises)) {
      throw new Error('Receive staging tree is missing an expected file');
    }
  }
}

async function verifyReadyToPublish(config: WriterConfig, isAborted: () => boolean): Promise<void> {
  await assertSafeTreeMatchesPlan(config);
  for (const record of config.files) { throwIfAborted(isAborted(), config.signal); await verifyCompletedFile(record, config); }
}

interface PublishedRoot {
  sourceRoot: string;
  stagingPath: string;
  finalPath: string;
  kind: string;
  method: 'link' | 'rename';
}

async function publishAllRoots(config: WriterConfig, isAborted: () => boolean): Promise<boolean> {
  const published: PublishedRoot[] = [];
  try {
    for (const root of config.plan.roots) {
      throwIfAborted(isAborted(), config.signal);
      await assertSafeDirectoryChain(config.plan.receiveRoot, config.fsPromises, 'Receive root');
      if (await lstatIfExists(root.finalPath, config.fsPromises)) {
        throw new Error('Receive target already exists; refusing to overwrite');
      }
      const sourceStat = await config.fsPromises.lstat(root.stagingPath);
      if (sourceStat.isSymbolicLink() || (root.kind === 'file' ? !sourceStat.isFile() : !sourceStat.isDirectory())) {
        throw new TypeError('Receive publication source changed type before publication');
      }
      if (root.kind === 'file') {
        await config.fsPromises.link(root.stagingPath, root.finalPath);
        published.push({ ...root, method: 'link' });
        try {
          await config.fsPromises.unlink(root.stagingPath);
        } catch (error) {
          await config.fsPromises.unlink(root.finalPath).catch(() => {});
          published.pop();
          throw error;
        }
      } else {
        await config.fsPromises.rename(root.stagingPath, root.finalPath);
        published.push({ ...root, method: 'rename' });
      }
    }
  } catch (error) {
    const rollbackErrors = await rollbackPublished(published, config);
    if (rollbackErrors.length > 0) {
      throw new AggregateError([error, ...rollbackErrors], 'Receive publication failed and rollback was incomplete');
    }
    throw error;
  }

  try {
    await cleanupReceiveStaging({
      fsPromises: config.fsPromises,
      receiveRoot: config.plan.receiveRoot,
      taskId: config.manifest.taskId,
    });
    return false;
  } catch {
    return true;
  }
}

async function rollbackPublished(published: PublishedRoot[], config: WriterConfig): Promise<unknown[]> {
  const errors: unknown[] = [];
  for (const root of published.reverse()) {
    try {
      if (root.method === 'rename') {
        await config.fsPromises.rename(root.finalPath, root.stagingPath);
      } else {
        await config.fsPromises.link(root.finalPath, root.stagingPath);
        await config.fsPromises.unlink(root.finalPath);
      }
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
}

async function assertSafeDirectoryChain(directory: string, fsPromises: typeof fs.promises, subject: string): Promise<void> {
  const stat = await fsPromises.lstat(directory);
  if (stat.isSymbolicLink()) throw new TypeError(`${subject} must not be a symbolic link`);
  if (!stat.isDirectory()) throw new TypeError(`${subject} must be a directory`);
}

async function lstatIfExists(target: string, fsPromises: typeof fs.promises): Promise<fs.Stats | null> {
  try { return await fsPromises.lstat(target); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}

function throwIfAborted(aborted: boolean, signal: AbortSignal | null): void {
  if (aborted) throw createAbortError(signal);
}

function createAbortError(signal: AbortSignal | null): Error {
  const error = new Error('Encrypted chunk receive was cancelled');
  error.name = 'AbortError';
  if (signal && Object.prototype.hasOwnProperty.call(signal, 'reason')) error.cause = (signal as AbortSignal & { reason: unknown }).reason;
  return error;
}

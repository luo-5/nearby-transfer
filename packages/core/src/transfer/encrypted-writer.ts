/**
 * Encrypted chunk writer: decrypts incoming chunks, writes to staging files,
 * verifies SHA-256, and atomically publishes to final paths.
 * Ported from src/v2/encrypted-chunk-writer.js (811 lines).
 *
 * The writer is async-created and returns a frozen object with writeChunk,
 * complete, cancel, and getCommittedProgress. It manages staging file safety
 * (no symlinks, identity checks), per-root publication via link/rename, and
 * in-process rollback on failure. Durable multi-root crash recovery remains a
 * caller-visible limitation documented in the package README.
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
  identity: FileIdentity | null;
}

interface FileIdentity {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
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
  let activeOperation: Promise<unknown> | null = null;
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
    const pending = (async () => {
      assertReceiving();
      return await operation();
    })();
    activeOperation = pending;
    try {
      return await pending;
    } catch (error) {
      if (terminalOnError && state === 'receiving') { state = abortRequested ? 'cancelled' : 'failed'; releaseKey(); }
      throw error;
    } finally {
      busy = false;
      if (activeOperation === pending) activeOperation = null;
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
      const cleanupPending = await publishAllRoots(config, () => abortRequested, () => {
        // This synchronous transition is the publication commit point. Before
        // it, cancellation is observed by publishAllRoots and every created
        // final target is rolled back. After it, cleanup is best-effort and a
        // concurrent cancel must not turn an already published task into an
        // error.
        state = 'published';
        releaseKey();
      });
      return Object.freeze({ files: config.files.length, published: true as const, cleanupPending, progress: snapshotProgress(config) });
    });
  }

  async function cancel(): Promise<WriterProgress> {
    if (state === 'published' || state === 'cancelled') return snapshotProgress(config);
    const operation = activeOperation;
    if (busy && operation) {
      abortRequested = true;
      try { await operation; } catch (_) { /* cancellation remains the terminal result */ }
    }
    if (state === 'published' || state === 'cancelled') return snapshotProgress(config);
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
    if (typeof target.stagingPath !== 'string' || typeof target.finalPath !== 'string' ||
        !path.isAbsolute(target.stagingPath) || !path.isAbsolute(target.finalPath)) {
      throw new TypeError('Receive target paths must be absolute');
    }
    targetByPath.set(target.path, target);
  }

  const roots = manifest.entries.length > 0
    ? Array.from(new Set(manifest.entries.map((e) => e.path.split('/')[0]!))).map((sourceRoot) => {
        const rootTarget = targetByPath.get(sourceRoot);
        if (!rootTarget) throw new TypeError(`Receive target plan is missing declared root: ${sourceRoot}`);
        return {
          sourceRoot,
          stagingPath: rootTarget.stagingPath,
          finalPath: rootTarget.finalPath,
          kind: rootTarget.kind,
        };
      })
    : [];

  for (const entry of manifest.entries) {
    const target = targetByPath.get(entry.path)!;
    const [sourceRoot, ...descendants] = entry.path.split('/');
    const root = roots.find((candidate) => candidate.sourceRoot === sourceRoot)!;
    const expectedStaging = path.join(value.stagingDirectory, ...entry.path.split('/'));
    const expectedFinal = path.join(root.finalPath, ...descendants);
    if (path.resolve(target.stagingPath) !== path.resolve(expectedStaging) ||
        path.resolve(target.finalPath) !== path.resolve(expectedFinal)) {
      throw new TypeError('Receive target plan mapping is inconsistent');
    }
    assertContainedPath(receiveRoot, target.finalPath, 'Receive final target');
    assertContainedPath(value.stagingDirectory, target.stagingPath, 'Receive staging target');
  }

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
    const after = await handle.stat();
    record.identity = identityFromStat(after);
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
    const before = await handle.stat();
    const hash = crypto.createHash('sha256');
    const buffer = Buffer.allocUnsafe(256 * 1024);
    let offset = 0;
    while (offset < before.size) {
      const result = await handle.read(buffer, 0, Math.min(buffer.length, before.size - offset), offset);
      if (result.bytesRead <= 0) throw new Error('Receive staging hash read ended unexpectedly');
      hash.update(buffer.subarray(0, result.bytesRead));
      offset += result.bytesRead;
    }
    const digest = hash.digest('hex');
    const after = await handle.stat();
    if (!sameFileSnapshot(identityFromStat(before), identityFromStat(after)) ||
        after.size !== record.entry.size || digest !== record.entry.sha256) {
      throw new Error(`Completed receive file does not match manifest: ${record.entry.path}`);
    }
    const pathStat = await config.fsPromises.lstat(record.target.stagingPath);
    if (pathStat.isSymbolicLink() || !pathStat.isFile() || !sameFileIdentity(identityFromStat(after), identityFromStat(pathStat))) {
      throw new Error(`Completed receive file path changed during verification: ${record.entry.path}`);
    }
    record.identity = identityFromStat(after);
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
  stagingRemoved: boolean;
}

async function publishAllRoots(
  config: WriterConfig,
  isAborted: () => boolean,
  commitPublication: () => void,
): Promise<boolean> {
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
        const record = config.files.find((candidate) => candidate.entry.path === root.sourceRoot);
        if (!record || !record.identity || !sameFileIdentity(record.identity, identityFromStat(sourceStat))) {
          throw new Error('Receive publication source changed after integrity verification');
        }
        try {
          await config.fsPromises.link(root.stagingPath, root.finalPath);
        } catch (error) {
          if (!isPublicationFallbackError(error)) throw error;
          const unsupported = new Error('Atomic receive publication requires hard-link support on the destination filesystem');
          (unsupported as NodeJS.ErrnoException).code = 'ATOMIC_PUBLICATION_UNSUPPORTED';
          (unsupported as Error & { cause?: unknown }).cause = error;
          throw unsupported;
        }
        try {
          await verifyPublishedRoot(root, config);
        } catch (error) {
          try {
            await config.fsPromises.unlink(root.finalPath);
          } catch (rollbackError) {
            throw new AggregateError([error, rollbackError], 'Receive publication verification failed and rollback was incomplete');
          }
          throw error;
        }
        const publishedRoot: PublishedRoot = { ...root, method: 'link', stagingRemoved: false };
        published.push(publishedRoot);
        throwIfAborted(isAborted(), config.signal);
        try {
          await config.fsPromises.unlink(root.stagingPath);
          publishedRoot.stagingRemoved = true;
        } catch {
          // The final hard link is already verified and durable. Leave the
          // owned staging link for the cleanup pass instead of reporting a
          // false transfer failure after publication.
        }
        throwIfAborted(isAborted(), config.signal);
      } else {
        await config.fsPromises.rename(root.stagingPath, root.finalPath);
        try {
          await verifyPublishedRoot(root, config);
        } catch (error) {
          try {
            await config.fsPromises.rename(root.finalPath, root.stagingPath);
          } catch (rollbackError) {
            throw new AggregateError([error, rollbackError], 'Receive publication verification failed and rollback was incomplete');
          }
          throw error;
        }
        published.push({ ...root, method: 'rename', stagingRemoved: true });
        throwIfAborted(isAborted(), config.signal);
      }
    }
    throwIfAborted(isAborted(), config.signal);
  } catch (error) {
    const rollbackErrors = await rollbackPublished(published, config);
    if (rollbackErrors.length > 0) {
      throw new AggregateError([error, ...rollbackErrors], 'Receive publication failed and rollback was incomplete');
    }
    throw error;
  }

  commitPublication();
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
        if (root.method === 'link' && root.stagingRemoved && !await lstatIfExists(root.stagingPath, config.fsPromises)) {
          await config.fsPromises.link(root.finalPath, root.stagingPath);
        }
        await config.fsPromises.unlink(root.finalPath);
      }
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
}

async function verifyPublishedRoot(
  root: WriterConfig['plan']['roots'][number],
  config: WriterConfig,
  requireSourceIdentity = true,
): Promise<void> {
  const expected = new Map<string, string>();
  for (const entry of config.manifest.entries) {
    if (entry.path !== root.sourceRoot && !entry.path.startsWith(`${root.sourceRoot}/`)) continue;
    const target = config.plan.targetByPath.get(entry.path)!;
    expected.set(target.finalPath, entry.kind);
  }

  async function visit(current: string): Promise<void> {
    const stat = await config.fsPromises.lstat(current);
    if (stat.isSymbolicLink()) throw new TypeError('Published receive tree contains a symbolic link or junction');
    const expectedKind = expected.get(current);
    if (!expectedKind) throw new Error('Published receive tree contains an unexpected entry');
    if (expectedKind === 'directory') {
      if (!stat.isDirectory()) throw new TypeError('Published receive tree entry must be a directory');
      for (const name of await config.fsPromises.readdir(current)) await visit(path.join(current, name));
    } else if (!stat.isFile()) {
      throw new TypeError('Published receive tree entry must be a regular file');
    }
  }
  await visit(root.finalPath);
  for (const record of config.files) {
    if (record.entry.path !== root.sourceRoot && !record.entry.path.startsWith(`${root.sourceRoot}/`)) continue;
    await verifyFileAtPath(record.target.finalPath, record, config, requireSourceIdentity);
  }
}

async function verifyFileAtPath(
  targetPath: string,
  record: FileRecord,
  config: WriterConfig,
  requireSourceIdentity: boolean,
): Promise<void> {
  const handle = await config.fsPromises.open(targetPath, fs.constants.O_RDONLY);
  try {
    const before = await handle.stat();
    if (requireSourceIdentity && (!record.identity || !sameFileIdentity(record.identity, identityFromStat(before)))) {
      throw new Error(`Published receive file identity changed: ${record.entry.path}`);
    }
    const hash = crypto.createHash('sha256');
    const buffer = Buffer.allocUnsafe(256 * 1024);
    let offset = 0;
    while (offset < before.size) {
      const result = await handle.read(buffer, 0, Math.min(buffer.length, before.size - offset), offset);
      if (result.bytesRead <= 0) throw new Error('Published receive hash read ended unexpectedly');
      hash.update(buffer.subarray(0, result.bytesRead));
      offset += result.bytesRead;
    }
    const after = await handle.stat();
    if (!sameFileSnapshot(identityFromStat(before), identityFromStat(after)) ||
        after.size !== record.entry.size || hash.digest('hex') !== record.entry.sha256) {
      throw new Error(`Published receive file does not match manifest: ${record.entry.path}`);
    }
    const pathStat = await config.fsPromises.lstat(targetPath);
    if (pathStat.isSymbolicLink() || !pathStat.isFile() || !sameFileIdentity(identityFromStat(after), identityFromStat(pathStat))) {
      throw new Error(`Published receive file path changed during verification: ${record.entry.path}`);
    }
  } finally {
    await handle.close();
  }
}

function isPublicationFallbackError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error &&
    ['ENOTSUP', 'EOPNOTSUPP', 'EPERM', 'EACCES', 'EXDEV'].includes(String((error as NodeJS.ErrnoException).code)));
}

function identityFromStat(stat: fs.Stats): FileIdentity {
  return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs };
}

function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size;
}

function sameFileSnapshot(left: FileIdentity, right: FileIdentity): boolean {
  return sameFileIdentity(left, right) && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function assertContainedPath(root: string, candidate: string, subject: string): void {
  const relative = path.relative(root, candidate);
  if (relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) return;
  throw new TypeError(`${subject} escapes its root`);
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

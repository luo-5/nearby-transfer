'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const util = require('util');
const {
  RESERVATION_ROOT_NAME,
  STAGING_PREFIX,
  STAGING_SUFFIX,
  cleanupReceiveStaging
} = require('./receive-target-planner');
const { normalizeTransferManifest } = require('./transfer-manifest');
const {
  KEY_BYTES,
  MAX_SEQUENCE,
  decryptChunk
} = require('./transfer-session-crypto');

const INPUT_KEYS = ['fsPromises', 'manifest', 'plan', 'resumeProgress', 'sessionKey', 'signal'];
const CHUNK_KEYS = ['authTag', 'ciphertext', 'nonce', 'offset', 'path', 'plainLength', 'sequence', 'taskId'];
const PROGRESS_KEYS = ['files', 'nextSequence'];
const FILE_PROGRESS_KEYS = ['committedOffset', 'completed', 'path'];
const PLAN_KEYS = ['receiveRoot', 'stagingDirectory', 'targets', 'taskId'];
const TARGET_KEYS = ['finalPath', 'kind', 'path', 'stagingPath'];
const WRITE_OPEN_FLAGS = fs.constants.O_RDWR |
  (typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0);
const CREATE_OPEN_FLAGS = WRITE_OPEN_FLAGS | fs.constants.O_CREAT | fs.constants.O_EXCL;
const READ_OPEN_FLAGS = fs.constants.O_RDONLY |
  (typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0);

async function createEncryptedChunkWriter(input) {
  const config = normalizeInput(input);
  try {
    if (config.signal && config.signal.aborted) throw createAbortError(config.signal);
    await prepareStaging(config);
  } catch (error) {
    config.sessionKey.fill(0);
    config.sessionKey = null;
    throw error;
  }

  let state = 'receiving';
  let busy = false;
  let abortRequested = Boolean(config.signal && config.signal.aborted);
  const onAbort = () => {
    abortRequested = true;
    if (!busy && state === 'receiving') {
      state = 'cancelled';
      releaseKey();
    }
  };
  if (config.signal) config.signal.addEventListener('abort', onAbort, { once: true });

  function releaseKey() {
    if (config.sessionKey) {
      config.sessionKey.fill(0);
      config.sessionKey = null;
    }
    if (config.signal) config.signal.removeEventListener('abort', onAbort);
  }

  function assertReceiving() {
    if (state !== 'receiving') throw new Error(`Encrypted chunk writer is ${state}`);
    if (abortRequested) throw createAbortError(config.signal);
  }

  async function runExclusive(operation, terminalOnError = true) {
    if (busy) throw new Error('Concurrent encrypted chunk writer operations are not supported');
    busy = true;
    try {
      assertReceiving();
      return await operation();
    } catch (error) {
      if (terminalOnError && state === 'receiving') {
        state = abortRequested ? 'cancelled' : 'failed';
        releaseKey();
      }
      throw error;
    } finally {
      busy = false;
    }
  }

  async function writeChunk(chunk) {
    return runExclusive(async () => {
      const metadata = validateChunkEnvelope(chunk, config);
      const record = currentFile(config);
      if (!record) throw new Error('All manifest files are already complete');
      if (metadata.path !== record.entry.path) {
        throw new Error(`Chunk path is out of order; expected ${record.entry.path}`);
      }
      if (metadata.offset !== record.committedOffset) {
        throw new Error(`Chunk offset is not the next committed offset for ${record.entry.path}`);
      }
      if (metadata.sequence !== config.nextSequence) {
        throw new Error('Chunk sequence is duplicated, skipped, or out of order');
      }

      validateChunkBounds(record, metadata);
      const completesFile = record.entry.size === 0 ||
        metadata.offset + metadata.plainLength === record.entry.size;
      const completesTask = completesFile && config.currentFileIndex === config.files.length - 1;
      if (metadata.sequence === MAX_SEQUENCE && !completesTask) {
        throw new RangeError('Chunk sequence space is exhausted before the transfer completes');
      }

      throwIfAborted(abortRequested, config.signal);
      let plaintext;
      try {
        plaintext = decryptChunk({
          key: config.sessionKey,
          nonce: chunk.nonce,
          taskId: metadata.taskId,
          path: metadata.path,
          offset: metadata.offset,
          sequence: metadata.sequence,
          plainLength: metadata.plainLength,
          ciphertext: chunk.ciphertext,
          authTag: chunk.authTag
        });
        throwIfAborted(abortRequested, config.signal);
        await commitPlaintext(record, plaintext, config, () => abortRequested);
      } finally {
        if (plaintext) plaintext.fill(0);
      }

      record.committedOffset += metadata.plainLength;
      if (completesFile) {
        try {
          await verifyCompletedFile(record, config);
        } catch (error) {
          await resetUnverifiedFile(record, config);
          throw error;
        }
        record.completed = true;
        config.currentFileIndex += 1;
      }
      if (metadata.sequence < MAX_SEQUENCE) config.nextSequence += 1;

      return snapshotProgress(config);
    });
  }

  async function complete() {
    return runExclusive(async () => {
      if (config.currentFileIndex !== config.files.length) {
        throw new Error('Cannot publish an incomplete transfer task');
      }
      throwIfAborted(abortRequested, config.signal);
      await verifyReadyToPublish(config, () => abortRequested);
      const cleanupPending = await publishAllRoots(config, () => abortRequested);
      state = 'published';
      releaseKey();
      return Object.freeze({
        files: config.files.length,
        published: true,
        cleanupPending,
        progress: snapshotProgress(config)
      });
    });
  }

  async function cancel() {
    if (busy) {
      abortRequested = true;
      throw new Error('Cannot cancel while an encrypted chunk writer operation is in progress');
    }
    if (state === 'published') throw new Error('Cannot cancel a published transfer task');
    if (state === 'cancelled') return snapshotProgress(config);
    if (state !== 'receiving') throw new Error(`Encrypted chunk writer is ${state}`);
    state = 'cancelled';
    releaseKey();
    return snapshotProgress(config);
  }

  return Object.freeze({
    cancel,
    complete,
    getCommittedProgress() {
      return snapshotProgress(config);
    },
    writeChunk
  });
}

function normalizeInput(input) {
  assertPlainDataObject(input, 'Encrypted chunk writer input');
  assertOnlyKeys(input, INPUT_KEYS, 'Encrypted chunk writer input');
  for (const key of ['manifest', 'plan', 'sessionKey']) requireOwn(input, key, 'Encrypted chunk writer input');

  const manifest = normalizeTransferManifest(input.manifest);
  if (!util.isDeepStrictEqual(input.manifest, manifest)) {
    throw new TypeError('Transfer manifest must already be normalized');
  }
  const fsPromises = normalizeFsPromises(input.fsPromises);
  const plan = normalizePlan(input.plan, manifest);
  const signal = normalizeAbortSignal(input.signal);
  const files = manifest.entries
    .filter((entry) => entry.kind === 'file')
    .map((entry) => ({
      entry,
      target: plan.targetByPath.get(entry.path),
      committedOffset: 0,
      completed: false,
      identity: null
    }));
  const progress = normalizeResumeProgress(input.resumeProgress, files);
  const sessionKey = copySessionKey(input.sessionKey);
  for (let index = 0; index < files.length; index += 1) {
    files[index].committedOffset = progress.files[index].committedOffset;
    files[index].completed = progress.files[index].completed;
  }

  return {
    files,
    fsPromises,
    manifest,
    nextSequence: progress.nextSequence,
    plan,
    resumed: input.resumeProgress !== undefined,
    sessionKey,
    signal,
    currentFileIndex: (() => {
      const index = files.findIndex((file) => !file.completed);
      return index === -1 ? files.length : index;
    })()
  };
}

function normalizePlan(value, manifest) {
  assertPlainDataObject(value, 'Receive target plan');
  assertExactKeys(value, PLAN_KEYS, 'Receive target plan');
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

  const targetByPath = new Map();
  const finalRootBySourceRoot = new Map();
  for (const target of value.targets) {
    assertPlainDataObject(target, 'Receive target');
    assertExactKeys(target, TARGET_KEYS, 'Receive target');
    if (targetByPath.has(target.path)) throw new TypeError('Receive target paths must be unique');
    const entry = manifest.entries.find((candidate) => candidate.path === target.path);
    if (!entry || entry.kind !== target.kind) throw new TypeError('Receive target does not match manifest');

    const components = entry.path.split('/');
    const expectedStagingPath = path.join(expectedStaging, ...components);
    if (target.stagingPath !== expectedStagingPath) {
      throw new TypeError('Receive target staging path does not match planner convention');
    }
    assertContained(expectedStaging, target.stagingPath, 'Receive staging target');
    assertContained(receiveRoot, target.finalPath, 'Receive final target');

    const finalRelative = path.relative(receiveRoot, target.finalPath);
    const finalComponents = finalRelative.split(path.sep);
    if (finalComponents.length !== components.length ||
        finalComponents.slice(1).some((component, index) => component !== components[index + 1])) {
      throw new TypeError('Receive target final path does not preserve the manifest tree');
    }
    const mappedRoot = finalRootBySourceRoot.get(components[0]);
    if (mappedRoot !== undefined && mappedRoot !== finalComponents[0]) {
      throw new TypeError('Receive target plan maps one source root inconsistently');
    }
    finalRootBySourceRoot.set(components[0], finalComponents[0]);
    targetByPath.set(target.path, Object.freeze({ ...target }));
  }

  for (const entry of manifest.entries) {
    if (!targetByPath.has(entry.path)) throw new TypeError('Receive target plan is missing a manifest entry');
  }

  const roots = [...finalRootBySourceRoot.entries()].map(([sourceRoot, finalRoot]) => ({
    sourceRoot,
    stagingPath: path.join(expectedStaging, sourceRoot),
    finalPath: path.join(receiveRoot, finalRoot),
    kind: manifest.entries.find((entry) => entry.path === sourceRoot).kind
  }));

  return Object.freeze({
    receiveRoot,
    stagingDirectory: expectedStaging,
    targetByPath,
    roots: Object.freeze(roots)
  });
}

function normalizeResumeProgress(value, files) {
  if (value === undefined) {
    return {
      nextSequence: 0,
      files: files.map((file) => ({ path: file.entry.path, committedOffset: 0, completed: false }))
    };
  }
  assertPlainDataObject(value, 'Receive resume progress');
  assertExactKeys(value, PROGRESS_KEYS, 'Receive resume progress');
  assertSafeInteger(value.nextSequence, 0, MAX_SEQUENCE, 'Receive next sequence');
  if (!Array.isArray(value.files) || value.files.length !== files.length) {
    throw new TypeError('Receive resume progress must cover every manifest file');
  }

  let sawIncomplete = false;
  const normalizedFiles = value.files.map((progress, index) => {
    assertPlainDataObject(progress, 'Receive file progress');
    assertExactKeys(progress, FILE_PROGRESS_KEYS, 'Receive file progress');
    const entry = files[index].entry;
    if (progress.path !== entry.path) throw new TypeError('Receive file progress order must match manifest');
    assertSafeInteger(progress.committedOffset, 0, entry.size, `Committed offset for ${entry.path}`);
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
      completed: progress.completed
    };
  });
  return { nextSequence: value.nextSequence, files: normalizedFiles };
}

async function prepareStaging(config) {
  await assertSafeDirectoryChain(config.plan.receiveRoot, config.fsPromises, 'Receive root');
  await assertSafeDirectory(config.plan.stagingDirectory, config.fsPromises, 'Task staging directory');
  for (const target of config.plan.targetByPath.values()) {
    if (target.kind === 'directory') {
      await assertSafeDirectory(target.stagingPath, config.fsPromises, 'Staging directory');
    } else {
      await assertSafeDirectoryChain(path.dirname(target.stagingPath), config.fsPromises, 'Staging parent');
    }
  }

  for (const record of config.files) {
    const stat = await lstatIfExists(record.target.stagingPath, config.fsPromises);
    if (!config.resumed) {
      if (stat) throw new Error(`Fresh receive staging file already exists: ${record.entry.path}`);
      continue;
    }
    if (!stat) {
      if (record.committedOffset !== 0 || record.completed) {
        throw new Error(`Committed receive staging file is missing: ${record.entry.path}`);
      }
      continue;
    }
    assertRegularFileStat(stat, record.entry.path);
    const handle = await openExistingFile(record.target.stagingPath, record.entry.path, config.fsPromises);
    try {
      const handleStat = await handle.stat();
      assertRegularFileStat(handleStat, record.entry.path);
      assertSameIdentity(stat, handleStat, record.entry.path);
      if (handleStat.size < record.committedOffset) {
        throw new Error(`Receive staging file is shorter than committed progress: ${record.entry.path}`);
      }
      if (handleStat.size !== record.committedOffset) {
        await handle.truncate(record.committedOffset);
        await handle.sync();
      }
      record.identity = identityOf(handleStat);
    } finally {
      await handle.close();
    }
    if (record.completed) await verifyCompletedFile(record, config);
  }
}

function validateChunkEnvelope(chunk, config) {
  assertPlainDataObject(chunk, 'Encrypted receive chunk');
  assertExactKeys(chunk, CHUNK_KEYS, 'Encrypted receive chunk');
  if (chunk.taskId !== config.manifest.taskId) throw new Error('Chunk taskId does not match receive task');
  if (typeof chunk.path !== 'string') throw new TypeError('Chunk path must be a string');
  assertSafeInteger(chunk.offset, 0, Number.MAX_SAFE_INTEGER, 'Chunk offset');
  assertSafeInteger(chunk.sequence, 0, MAX_SEQUENCE, 'Chunk sequence');
  assertSafeInteger(chunk.plainLength, 0, Number.MAX_SAFE_INTEGER, 'Chunk plaintext length');
  return chunk;
}

function validateChunkBounds(record, chunk) {
  if (record.entry.size === 0) {
    if (chunk.offset !== 0 || chunk.plainLength !== 0 || record.completed) {
      throw new RangeError('Empty files require exactly one zero-length marker chunk');
    }
    return;
  }
  if (chunk.plainLength === 0) throw new RangeError('Non-empty files reject zero-length chunks');
  if (chunk.offset + chunk.plainLength > record.entry.size) {
    throw new RangeError('Chunk exceeds the manifest file size');
  }
}

async function commitPlaintext(record, plaintext, config, isAborted) {
  await assertSafeDirectoryChain(path.dirname(record.target.stagingPath), config.fsPromises, 'Staging parent');
  let handle;
  try {
    handle = await openStagingFile(record, config);
    const before = await handle.stat();
    assertRegularFileStat(before, record.entry.path);
    if (record.identity) assertSameIdentity(record.identity, before, record.entry.path);
    const pathStat = await config.fsPromises.lstat(record.target.stagingPath);
    assertRegularFileStat(pathStat, record.entry.path);
    assertSameIdentity(before, pathStat, record.entry.path);
    record.identity = identityOf(before);

    if (before.size < record.committedOffset) {
      throw new Error(`Receive staging file is shorter than committed progress: ${record.entry.path}`);
    }
    if (before.size !== record.committedOffset) {
      await handle.truncate(record.committedOffset);
      await handle.sync();
    }
    throwIfAborted(isAborted(), config.signal);
    await writeExactly(handle, plaintext, record.committedOffset, isAborted, config.signal);
    throwIfAborted(isAborted(), config.signal);
    await handle.sync();
    throwIfAborted(isAborted(), config.signal);
    const after = await handle.stat();
    if (after.size !== record.committedOffset + plaintext.length) {
      throw new Error(`Receive staging file size changed unexpectedly: ${record.entry.path}`);
    }
    assertSameIdentity(record.identity, after, record.entry.path);
  } catch (error) {
    if (handle) {
      await handle.truncate(record.committedOffset).catch(() => {});
      await handle.sync().catch(() => {});
    }
    throw error;
  } finally {
    if (handle) await handle.close();
  }
}

async function openStagingFile(record, config) {
  const existing = await lstatIfExists(record.target.stagingPath, config.fsPromises);
  if (!existing) {
    try {
      return await config.fsPromises.open(record.target.stagingPath, CREATE_OPEN_FLAGS, 0o600);
    } catch (error) {
      if (error && error.code === 'ELOOP') throw new TypeError('Staging files must not be symbolic links or junctions', { cause: error });
      throw error;
    }
  }
  if (!config.resumed && record.committedOffset === 0 && !record.identity) {
    throw new Error(`Fresh receive staging file already exists: ${record.entry.path}`);
  }
  assertRegularFileStat(existing, record.entry.path);
  return openExistingFile(record.target.stagingPath, record.entry.path, config.fsPromises);
}

async function openExistingFile(filePath, relativePath, fsPromises) {
  try {
    return await fsPromises.open(filePath, WRITE_OPEN_FLAGS);
  } catch (error) {
    if (error && error.code === 'ELOOP') {
      throw new TypeError(`Receive staging file must not be a symbolic link: ${relativePath}`, { cause: error });
    }
    throw error;
  }
}

async function writeExactly(handle, plaintext, position, isAborted, signal) {
  let written = 0;
  while (written < plaintext.length) {
    throwIfAborted(isAborted(), signal);
    const result = await handle.write(plaintext, written, plaintext.length - written, position + written);
    if (!result || !Number.isSafeInteger(result.bytesWritten) || result.bytesWritten <= 0) {
      throw new Error('Receive staging write made no forward progress');
    }
    written += result.bytesWritten;
  }
}

async function resetUnverifiedFile(record, config) {
  const stat = await lstatIfExists(record.target.stagingPath, config.fsPromises);
  if (stat && stat.isFile() && !stat.isSymbolicLink()) {
    const handle = await openExistingFile(record.target.stagingPath, record.entry.path, config.fsPromises);
    try {
      await handle.truncate(0);
      await handle.sync();
      record.identity = identityOf(await handle.stat());
    } finally {
      await handle.close();
    }
  }
  record.committedOffset = 0;
  record.completed = false;
}

async function verifyCompletedFile(record, config) {
  const digest = await hashSafeStagingFile(record, config);
  if (digest.size !== record.entry.size || digest.sha256 !== record.entry.sha256) {
    throw new Error(`Completed receive file does not match manifest: ${record.entry.path}`);
  }
}

async function hashSafeStagingFile(record, config) {
  await assertSafeDirectoryChain(path.dirname(record.target.stagingPath), config.fsPromises, 'Staging parent');
  const before = await config.fsPromises.lstat(record.target.stagingPath);
  assertRegularFileStat(before, record.entry.path);
  const handle = await config.fsPromises.open(record.target.stagingPath, READ_OPEN_FLAGS);
  try {
    const opened = await handle.stat();
    assertRegularFileStat(opened, record.entry.path);
    assertSameIdentity(before, opened, record.entry.path);
    if (record.identity) assertSameIdentity(record.identity, opened, record.entry.path);
    const hash = crypto.createHash('sha256');
    const buffer = Buffer.allocUnsafe(256 * 1024);
    let offset = 0;
    try {
      while (offset < opened.size) {
        const result = await handle.read(buffer, 0, Math.min(buffer.length, opened.size - offset), offset);
        if (!result || result.bytesRead <= 0) throw new Error('Receive staging hash read ended unexpectedly');
        hash.update(buffer.subarray(0, result.bytesRead));
        buffer.fill(0, 0, result.bytesRead);
        offset += result.bytesRead;
      }
    } finally {
      buffer.fill(0);
    }
    const after = await handle.stat();
    assertSameIdentity(opened, after, record.entry.path);
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) {
      throw new Error(`Receive staging file changed while hashing: ${record.entry.path}`);
    }
    const pathAfter = await config.fsPromises.lstat(record.target.stagingPath);
    assertSameIdentity(opened, pathAfter, record.entry.path);
    return { size: opened.size, sha256: hash.digest('hex') };
  } finally {
    await handle.close();
  }
}

async function verifyReadyToPublish(config, isAborted) {
  await assertSafeDirectoryChain(config.plan.receiveRoot, config.fsPromises, 'Receive root');
  await assertSafeTreeMatchesPlan(config);
  for (const record of config.files) {
    throwIfAborted(isAborted(), config.signal);
    await verifyCompletedFile(record, config);
  }
  for (const root of config.plan.roots) {
    throwIfAborted(isAborted(), config.signal);
    const finalStat = await lstatIfExists(root.finalPath, config.fsPromises);
    if (finalStat) throw new Error('A reserved receive target appeared before publication');
  }
}

async function assertSafeTreeMatchesPlan(config) {
  const expected = new Map();
  expected.set(config.plan.stagingDirectory, 'directory');
  for (const target of config.plan.targetByPath.values()) expected.set(target.stagingPath, target.kind);

  async function visit(current) {
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

async function publishAllRoots(config, isAborted) {
  const published = [];
  try {
    for (const root of config.plan.roots) {
      throwIfAborted(isAborted(), config.signal);
      await assertSafeDirectoryChain(config.plan.receiveRoot, config.fsPromises, 'Receive root');
      if (await lstatIfExists(root.finalPath, config.fsPromises)) {
        throw new Error('Receive target already exists; refusing to overwrite');
      }
      const sourceStat = await config.fsPromises.lstat(root.stagingPath);
      if (sourceStat.isSymbolicLink() ||
          (root.kind === 'file' ? !sourceStat.isFile() : !sourceStat.isDirectory())) {
        throw new TypeError('Receive publication source changed type before publication');
      }
      if (root.kind === 'file') {
        await config.fsPromises.link(root.stagingPath, root.finalPath);
        const linkedStat = await config.fsPromises.lstat(root.finalPath);
        try {
          assertRegularFileStat(linkedStat, root.sourceRoot);
          assertSameIdentity(sourceStat, linkedStat, root.sourceRoot);
        } catch (error) {
          await config.fsPromises.unlink(root.finalPath).catch(() => {});
          throw error;
        }
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
        const publishedStat = await config.fsPromises.lstat(root.finalPath);
        if (publishedStat.isSymbolicLink() || !publishedStat.isDirectory()) {
          throw new TypeError('Published receive directory changed type during publication');
        }
        assertSameIdentity(sourceStat, publishedStat, root.sourceRoot);
      }
      throwIfAborted(isAborted(), config.signal);
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
      taskId: config.manifest.taskId
    });
    return false;
  } catch (_) {
    // Publication is already complete. A cleanup residue is recoverable and
    // must not turn a successful publish into a misleading transfer failure.
    return true;
  }
}

async function rollbackPublished(published, config) {
  const errors = [];
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

function currentFile(config) {
  return config.currentFileIndex === -1 || config.currentFileIndex >= config.files.length
    ? null
    : config.files[config.currentFileIndex];
}

function snapshotProgress(config) {
  return Object.freeze({
    nextSequence: config.nextSequence,
    files: Object.freeze(config.files.map((record) => Object.freeze({
      path: record.entry.path,
      committedOffset: record.committedOffset,
      completed: record.completed
    })))
  });
}

function normalizeFsPromises(value) {
  const candidate = value === undefined ? fs.promises : value;
  if (!candidate || typeof candidate !== 'object') throw new TypeError('fsPromises must be an object');
  for (const method of ['link', 'lstat', 'mkdir', 'open', 'readdir', 'rename', 'rm', 'rmdir', 'unlink']) {
    if (typeof candidate[method] !== 'function') throw new TypeError(`fsPromises.${method} must be a function`);
  }
  return candidate;
}

function copySessionKey(value) {
  if (!(Buffer.isBuffer(value) || value instanceof Uint8Array) || value.length !== KEY_BYTES) {
    throw new TypeError(`Session key must contain exactly ${KEY_BYTES} bytes`);
  }
  return Buffer.from(value);
}

function normalizeAbortSignal(value) {
  if (value === undefined) return null;
  if (!value || typeof value !== 'object' || typeof value.aborted !== 'boolean' ||
      typeof value.addEventListener !== 'function' || typeof value.removeEventListener !== 'function') {
    throw new TypeError('signal must be an AbortSignal');
  }
  return value;
}

async function assertSafeDirectoryChain(directory, fsPromises, subject) {
  const parsed = path.parse(directory);
  let current = parsed.root;
  await assertSafeDirectory(current, fsPromises, subject);
  const relative = path.relative(parsed.root, directory);
  if (!relative) return;
  for (const component of relative.split(path.sep)) {
    current = path.join(current, component);
    await assertSafeDirectory(current, fsPromises, subject);
  }
}

async function assertSafeDirectory(directory, fsPromises, subject) {
  const stat = await fsPromises.lstat(directory);
  if (stat.isSymbolicLink()) throw new TypeError(`${subject} must not be a symbolic link or junction`);
  if (!stat.isDirectory()) throw new TypeError(`${subject} must be a directory`);
}

function assertRegularFileStat(stat, relativePath) {
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new TypeError(`Receive staging target must be a regular file: ${relativePath}`);
  }
}

function identityOf(stat) {
  return { dev: stat.dev, ino: stat.ino };
}

function assertSameIdentity(left, right, relativePath) {
  if (left.dev !== right.dev || left.ino !== right.ino) {
    throw new Error(`Receive staging file identity changed: ${relativePath}`);
  }
}

function assertContained(root, candidate, subject) {
  const relative = path.relative(root, candidate);
  if (relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) return;
  throw new TypeError(`${subject} escapes its owned root`);
}

async function lstatIfExists(target, fsPromises) {
  try {
    return await fsPromises.lstat(target);
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
}

function throwIfAborted(aborted, signal) {
  if (aborted) throw createAbortError(signal);
}

function createAbortError(signal) {
  const error = new Error('Encrypted chunk receive was cancelled');
  error.name = 'AbortError';
  if (signal && Object.prototype.hasOwnProperty.call(signal, 'reason')) error.cause = signal.reason;
  return error;
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

function assertOnlyKeys(value, allowedKeys, subject) {
  const allowed = new Set(allowedKeys);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new TypeError(`${subject} contains unknown fields`);
}

function assertExactKeys(value, expectedKeys, subject) {
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${subject} contains missing or unknown fields`);
  }
}

function requireOwn(value, key, subject) {
  if (!Object.prototype.hasOwnProperty.call(value, key)) throw new TypeError(`${subject} is missing ${key}`);
}

function assertSafeInteger(value, minimum, maximum, subject) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${subject} must be a safe integer between ${minimum} and ${maximum}`);
  }
}

module.exports = {
  createEncryptedChunkWriter
};

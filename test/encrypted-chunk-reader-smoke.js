'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const readerModulePath = require.resolve('../src/v2/encrypted-chunk-reader');
const transferCrypto = require('../src/v2/transfer-session-crypto');
const { createEncryptedChunkReader } = require(readerModulePath);
const { decryptChunk, MAX_CHUNK_BYTES, MAX_SEQUENCE } = transferCrypto;
const { buildTransferSourceManifest } = require('../src/v2/transfer-source-manifest');

const TASK_ID = Buffer.alloc(16, 23).toString('base64url');
const SESSION_KEY = Buffer.alloc(32, 91);

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nearby-transfer-encrypted-reader-'));
  try {
    await testMultipleFilesResumeAndDecrypt(root);
    await testResumeAndSequenceBoundaries(root);
    await testEarlyTerminationCleanup(root);
    await testAbortCleanup(root);
    await testOutputOwnershipAndPlaintextWiping(root);
    await testEncryptionFailureCleanup(root);
    await testSourceMutationAndReplacement(root);
    await testInvalidMappings(root);
    console.log('encrypted chunk reader smoke test passed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function testMultipleFilesResumeAndDecrypt(root) {
  const folder = path.join(root, 'multi');
  fs.mkdirSync(folder);
  const alpha = path.join(folder, 'alpha.bin');
  const beta = path.join(folder, 'beta.txt');
  const empty = path.join(folder, 'empty.dat');
  fs.writeFileSync(alpha, Buffer.from('ABCDEFGHIJ'));
  fs.writeFileSync(beta, Buffer.from('uvwxyz'));
  fs.writeFileSync(empty, Buffer.alloc(0));

  const prepared = await buildTransferSourceManifest([alpha, beta, empty], { taskId: TASK_ID });
  const chunks = await collect(createEncryptedChunkReader({
    manifest: prepared.manifest,
    sourceFiles: prepared.files,
    sessionKey: SESSION_KEY,
    resumeOffsets: { 'alpha.bin': 4, 'beta.txt': 6 },
    chunkSize: 4,
    startSequence: 17
  }));

  assert.deepStrictEqual(chunks.map((chunk) => [chunk.path, chunk.offset, chunk.sequence, chunk.plainLength]), [
    ['alpha.bin', 4, 17, 4],
    ['alpha.bin', 8, 18, 2],
    ['empty.dat', 0, 19, 0]
  ]);
  assert.ok(chunks.every((chunk) => Object.isFrozen(chunk)));
  assert.ok(chunks.every((chunk) => !Object.prototype.hasOwnProperty.call(chunk, 'plaintext')));
  assert.ok(chunks.every((chunk) => chunk.ciphertext.length === chunk.plainLength));

  const recovered = chunks.map((chunk) => decrypt(chunk));
  assert.strictEqual(Buffer.concat(recovered.slice(0, 2)).toString(), 'EFGHIJ');
  assert.strictEqual(recovered[2].length, 0);
  assert.notStrictEqual(chunks[0].nonce.toString('hex'), chunks[1].nonce.toString('hex'));

  assert.throws(() => createEncryptedChunkReader({
    manifest: prepared.manifest,
    sourceFiles: prepared.files,
    sessionKey: SESSION_KEY,
    chunkSize: MAX_CHUNK_BYTES + 1
  }), /chunk size/i);
  assert.throws(() => createEncryptedChunkReader({
    manifest: prepared.manifest,
    sourceFiles: prepared.files,
    sessionKey: SESSION_KEY,
    resumeOffsets: { 'alpha.bin': 11 },
    chunkSize: 4
  }), /resume offset/i);
  assert.throws(() => createEncryptedChunkReader({
    manifest: prepared.manifest,
    sourceFiles: prepared.files,
    sessionKey: SESSION_KEY,
    resumeOffsets: { 'alpha.bin': 3 },
    chunkSize: 4
  }), /chunk-aligned/i);
}

async function testResumeAndSequenceBoundaries(root) {
  const folder = path.join(root, 'boundaries');
  fs.mkdirSync(folder);
  const empty = path.join(folder, 'empty.bin');
  const data = path.join(folder, 'data.bin');
  fs.writeFileSync(empty, Buffer.alloc(0));
  fs.writeFileSync(data, Buffer.from('12345678'));

  const emptyPrepared = await buildTransferSourceManifest([empty], { taskId: TASK_ID });
  const emptyChunks = await collect(createEncryptedChunkReader({
    manifest: emptyPrepared.manifest,
    sourceFiles: emptyPrepared.files,
    sessionKey: SESSION_KEY,
    startSequence: MAX_SEQUENCE
  }));
  assert.strictEqual(emptyChunks.length, 1, 'an empty file must emit one authenticated marker chunk');
  assert.deepStrictEqual(
    [emptyChunks[0].offset, emptyChunks[0].plainLength, emptyChunks[0].sequence],
    [0, 0, MAX_SEQUENCE]
  );
  assert.strictEqual(decrypt(emptyChunks[0]).length, 0);

  const dataPrepared = await buildTransferSourceManifest([data], { taskId: TASK_ID });
  const skipped = await collect(createEncryptedChunkReader({
    manifest: dataPrepared.manifest,
    sourceFiles: dataPrepared.files,
    sessionKey: SESSION_KEY,
    resumeOffsets: { 'data.bin': 8 },
    chunkSize: 4,
    startSequence: MAX_SEQUENCE
  }));
  assert.deepStrictEqual(skipped, []);

  assert.throws(() => createEncryptedChunkReader({
    manifest: dataPrepared.manifest,
    sourceFiles: dataPrepared.files,
    sessionKey: SESSION_KEY,
    chunkSize: 4,
    startSequence: MAX_SEQUENCE
  }), /sequence/i);
}

async function testEarlyTerminationCleanup(root) {
  const source = path.join(root, 'early.bin');
  fs.writeFileSync(source, Buffer.from('abcdefghijkl'));
  const prepared = await buildTransferSourceManifest([source], { taskId: TASK_ID });

  await withOpenSpy(async (openState) => {
    const observed = createObservation();
    const instrumented = loadInstrumentedReader(observed);
    const iterator = instrumented({
      manifest: prepared.manifest,
      sourceFiles: prepared.files,
      sessionKey: SESSION_KEY,
      chunkSize: 4
    });
    const first = await iterator.next();
    assert.strictEqual(first.done, false);
    assertAllZero(observed.plaintexts[0], 'plaintext must be wiped before yielding');
    assert.ok(observed.keys[0].some((byte) => byte !== 0));
    const stopped = await iterator.return('stopped');
    assert.deepStrictEqual(stopped, { value: 'stopped', done: true });
    assertAllZero(observed.keys[0], 'session key must be wiped on iterator.return()');
    assert.strictEqual(openState.closeCount, 1);
  });

  await withOpenSpy(async (openState) => {
    const observed = createObservation();
    const instrumented = loadInstrumentedReader(observed);
    const iterator = instrumented({
      manifest: prepared.manifest,
      sourceFiles: prepared.files,
      sessionKey: SESSION_KEY,
      chunkSize: 4
    });
    await iterator.next();
    const marker = new Error('consumer failure');
    await assert.rejects(iterator.throw(marker), (error) => error === marker);
    assertAllZero(observed.keys[0], 'session key must be wiped on iterator.throw()');
    assert.strictEqual(openState.closeCount, 1);
  });

  await withOpenSpy(async (openState) => {
    const iterator = createEncryptedChunkReader({
      manifest: prepared.manifest,
      sourceFiles: prepared.files,
      sessionKey: SESSION_KEY,
      chunkSize: 4
    });
    assert.deepStrictEqual(await iterator.return('unused'), { value: 'unused', done: true });
    assert.deepStrictEqual(await iterator.next(), { value: undefined, done: true });
    assert.strictEqual(openState.openCount, 0, 'return before first next must not open a source');
  });
}

async function testAbortCleanup(root) {
  const source = path.join(root, 'abort.bin');
  fs.writeFileSync(source, Buffer.alloc(32, 7));
  const prepared = await buildTransferSourceManifest([source], { taskId: TASK_ID });

  await withOpenSpy(async (openState) => {
    const observed = createObservation();
    const instrumented = loadInstrumentedReader(observed);
    const controller = new AbortController();
    const iterator = instrumented({
      manifest: prepared.manifest,
      sourceFiles: prepared.files,
      sessionKey: SESSION_KEY,
      chunkSize: 8,
      signal: controller.signal
    });

    assert.strictEqual((await iterator.next()).done, false);
    controller.abort(new Error('test abort'));
    await new Promise((resolve) => setImmediate(resolve));
    assertAllZero(observed.keys[0], 'abort must wipe the session key while the generator is suspended');
    assert.strictEqual(openState.closeCount, 1, 'abort must close the active handle without another next()');
    await assert.rejects(iterator.next(), (error) => error && error.name === 'AbortError');
  });

  const preAborted = new AbortController();
  preAborted.abort();
  const iterator = createEncryptedChunkReader({
    manifest: prepared.manifest,
    sourceFiles: prepared.files,
    sessionKey: SESSION_KEY,
    signal: preAborted.signal
  });
  await assert.rejects(iterator.next(), (error) => error && error.name === 'AbortError');
}

async function testOutputOwnershipAndPlaintextWiping(root) {
  const source = path.join(root, 'ownership.bin');
  fs.writeFileSync(source, Buffer.from('abcdefgh'));
  const prepared = await buildTransferSourceManifest([source], { taskId: TASK_ID });
  const observed = createObservation();
  const instrumented = loadInstrumentedReader(observed);
  const iterator = instrumented({
    manifest: prepared.manifest,
    sourceFiles: prepared.files,
    sessionKey: SESSION_KEY,
    chunkSize: 4
  });

  const first = (await iterator.next()).value;
  assert.strictEqual(decrypt(first).toString(), 'abcd');
  assertAllZero(observed.plaintexts[0], 'reader-owned plaintext must be wiped');
  assertAllZero(observed.encrypted[0].nonce, 'encryptor nonce must be wiped after ownership transfer');
  assertAllZero(observed.encrypted[0].ciphertext, 'encryptor ciphertext must be wiped after ownership transfer');
  assertAllZero(observed.encrypted[0].authTag, 'encryptor tag must be wiped after ownership transfer');
  assert.notStrictEqual(first.nonce, observed.encrypted[0].nonce);
  assert.notStrictEqual(first.ciphertext, observed.encrypted[0].ciphertext);
  assert.notStrictEqual(first.authTag, observed.encrypted[0].authTag);

  first.nonce.fill(0);
  first.ciphertext.fill(0);
  first.authTag.fill(0);
  const second = (await iterator.next()).value;
  assert.strictEqual(decrypt(second).toString(), 'efgh', 'mutating one output must not affect later chunks');
  await iterator.return();
  assertAllZero(observed.keys[0], 'session key must be wiped after output consumption stops');
}

async function testEncryptionFailureCleanup(root) {
  const source = path.join(root, 'encrypt-failure.bin');
  fs.writeFileSync(source, Buffer.from('failure'));
  const prepared = await buildTransferSourceManifest([source], { taskId: TASK_ID });
  const observed = createObservation();
  const injected = new Error('injected encryption failure');
  observed.throwOnEncrypt = injected;
  const instrumented = loadInstrumentedReader(observed);

  await withOpenSpy(async (openState) => {
    await assert.rejects(collect(instrumented({
      manifest: prepared.manifest,
      sourceFiles: prepared.files,
      sessionKey: SESSION_KEY,
      chunkSize: 4
    })), (error) => error === injected);
    assertAllZero(observed.plaintexts[0], 'plaintext must be wiped when encryption throws');
    assertAllZero(observed.keys[0], 'session key must be wiped when encryption throws');
    assert.strictEqual(openState.closeCount, 1);
  });
}

async function testSourceMutationAndReplacement(root) {
  const mutable = path.join(root, 'mutable.bin');
  fs.writeFileSync(mutable, Buffer.from('12345678'));
  const mutablePrepared = await buildTransferSourceManifest([mutable], { taskId: TASK_ID });
  const iterator = createEncryptedChunkReader({
    manifest: mutablePrepared.manifest,
    sourceFiles: mutablePrepared.files,
    sessionKey: SESSION_KEY,
    chunkSize: 4
  });
  assert.strictEqual((await iterator.next()).done, false);
  fs.writeFileSync(mutable, Buffer.from('87654321'));
  await assert.rejects(iterator.next(), /source (?:changed|content no longer matches)/i);

  const raced = path.join(root, 'raced.bin');
  const backup = path.join(root, 'raced-original.bin');
  fs.writeFileSync(raced, Buffer.from('original'));
  const racedPrepared = await buildTransferSourceManifest([raced], { taskId: TASK_ID });
  const originalOpen = fs.promises.open;
  let replaced = false;
  fs.promises.open = async function patchedOpen(target, ...args) {
    if (!replaced && path.resolve(target) === path.resolve(raced)) {
      replaced = true;
      fs.renameSync(raced, backup);
      fs.writeFileSync(raced, Buffer.from('replaced'));
    }
    return originalOpen.call(this, target, ...args);
  };
  try {
    await assert.rejects(collect(createEncryptedChunkReader({
      manifest: racedPrepared.manifest,
      sourceFiles: racedPrepared.files,
      sessionKey: SESSION_KEY,
      chunkSize: 4
    })), /identity changed|source changed/i);
  } finally {
    fs.promises.open = originalOpen;
  }
}

async function testInvalidMappings(root) {
  const folder = path.join(root, 'mapping');
  fs.mkdirSync(folder);
  const source = path.join(folder, 'mapping.bin');
  const twin = path.join(folder, 'twin.bin');
  fs.writeFileSync(source, Buffer.from('mapping'));
  fs.writeFileSync(twin, Buffer.from('mapping'));
  const prepared = await buildTransferSourceManifest([source], { taskId: TASK_ID });
  const record = prepared.files[0];

  assert.throws(() => createEncryptedChunkReader({
    manifest: prepared.manifest,
    sourceFiles: [],
    sessionKey: SESSION_KEY
  }), /exactly one record/i);
  assert.throws(() => createEncryptedChunkReader({
    manifest: prepared.manifest,
    sourceFiles: [{ ...record, size: record.size + 1 }],
    sessionKey: SESSION_KEY
  }), /metadata does not match/i);
  assert.throws(() => createEncryptedChunkReader({
    manifest: prepared.manifest,
    sourceFiles: [{ ...record, extra: true }],
    sessionKey: SESSION_KEY
  }), /missing or unknown fields/i);

  const inherited = Object.assign(Object.create({ polluted: true }), record);
  assert.throws(() => createEncryptedChunkReader({
    manifest: prepared.manifest,
    sourceFiles: [inherited],
    sessionKey: SESSION_KEY
  }), /plain object/i);

  const symbolRecord = { ...record };
  symbolRecord[Symbol('polluted')] = true;
  assert.throws(() => createEncryptedChunkReader({
    manifest: prepared.manifest,
    sourceFiles: [symbolRecord],
    sessionKey: SESSION_KEY
  }), /enumerable string data properties/i);

  const accessorRecord = { ...record };
  Object.defineProperty(accessorRecord, 'sourcePath', {
    enumerable: true,
    get() { return record.sourcePath; }
  });
  assert.throws(() => createEncryptedChunkReader({
    manifest: prepared.manifest,
    sourceFiles: [accessorRecord],
    sessionKey: SESSION_KEY
  }), /enumerable string data properties/i);

  const pollutedOffsets = Object.create(null);
  pollutedOffsets.__proto__ = 0;
  assert.throws(() => createEncryptedChunkReader({
    manifest: prepared.manifest,
    sourceFiles: prepared.files,
    sessionKey: SESSION_KEY,
    resumeOffsets: pollutedOffsets
  }), /unknown manifest path/i);

  const twoPrepared = await buildTransferSourceManifest([source, twin], { taskId: TASK_ID });
  assert.throws(() => createEncryptedChunkReader({
    manifest: twoPrepared.manifest,
    sourceFiles: [twoPrepared.files[0], { ...twoPrepared.files[1], sourcePath: twoPrepared.files[0].sourcePath }],
    sessionKey: SESSION_KEY
  }), /reuse the same filesystem path/i);
  assert.throws(() => createEncryptedChunkReader({
    manifest: twoPrepared.manifest,
    sourceFiles: [twoPrepared.files[0], { ...twoPrepared.files[0] }],
    sessionKey: SESSION_KEY
  }), /duplicate|unknown manifest path/i);

  const directory = path.join(folder, 'not-a-file');
  fs.mkdirSync(directory);
  await assert.rejects(collect(createEncryptedChunkReader({
    manifest: prepared.manifest,
    sourceFiles: [{ ...record, sourcePath: directory }],
    sessionKey: SESSION_KEY
  })), /regular file/i);

  const link = path.join(folder, 'mapping-link.bin');
  try {
    fs.symlinkSync(source, link, 'file');
    await assert.rejects(collect(createEncryptedChunkReader({
      manifest: prepared.manifest,
      sourceFiles: [{ ...record, sourcePath: link }],
      sessionKey: SESSION_KEY
    })), /symbolic links/i);
  } catch (error) {
    if (!error || !['EPERM', 'EACCES'].includes(error.code)) throw error;
  }
}

function loadInstrumentedReader(observed) {
  const originalEncryptChunk = transferCrypto.encryptChunk;
  transferCrypto.encryptChunk = (input) => {
    observed.keys.push(input.key);
    observed.plaintexts.push(input.plaintext);
    if (observed.throwOnEncrypt) throw observed.throwOnEncrypt;
    const encrypted = originalEncryptChunk(input);
    observed.encrypted.push(encrypted);
    return encrypted;
  };
  delete require.cache[readerModulePath];
  try {
    return require(readerModulePath).createEncryptedChunkReader;
  } finally {
    transferCrypto.encryptChunk = originalEncryptChunk;
    delete require.cache[readerModulePath];
  }
}

function createObservation() {
  return { encrypted: [], keys: [], plaintexts: [], throwOnEncrypt: null };
}

async function withOpenSpy(action) {
  const originalOpen = fs.promises.open;
  const state = { closeCount: 0, openCount: 0 };
  fs.promises.open = async function trackedOpen(...args) {
    const handle = await originalOpen.apply(this, args);
    state.openCount += 1;
    return {
      read: handle.read.bind(handle),
      stat: handle.stat.bind(handle),
      close: async () => {
        state.closeCount += 1;
        return handle.close();
      }
    };
  };
  try {
    await action(state);
  } finally {
    fs.promises.open = originalOpen;
  }
}

function decrypt(chunk) {
  return decryptChunk({
    key: SESSION_KEY,
    nonce: chunk.nonce,
    taskId: chunk.taskId,
    path: chunk.path,
    offset: chunk.offset,
    sequence: chunk.sequence,
    plainLength: chunk.plainLength,
    ciphertext: chunk.ciphertext,
    authTag: chunk.authTag
  });
}

function assertAllZero(value, message) {
  assert.ok(value && value.every((byte) => byte === 0), message);
}

async function collect(iterable) {
  const values = [];
  for await (const value of iterable) values.push(value);
  return values;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createEncryptedChunkWriter } = require('../src/v2/encrypted-chunk-writer');
const {
  cleanupReceiveStaging,
  planReceiveTargets
} = require('../src/v2/receive-target-planner');
const { createTransferManifest } = require('../src/v2/transfer-manifest');
const { encryptChunk } = require('../src/v2/transfer-session-crypto');

const SESSION_KEY = Buffer.alloc(32, 0x5a);
let taskCounter = 40;

async function main() {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'nearby-transfer-chunk-writer-'));
  try {
    await testMultiFileEmptyAndAtomicPublish(sandbox);
    await testStrictOrderingAndBounds(sandbox);
    await testAuthenticationFailureAndSafeProgress(sandbox);
    await testResumeTruncatesUncommittedTail(sandbox);
    await testHashMismatchNeverPublishes(sandbox);
    await testWriteFailureRollsBackUncommittedBytes(sandbox);
    await testAbortAndExplicitCancel(sandbox);
    await testSymlinkJunctionAndUnexpectedEntryDefense(sandbox);
    await testNoOverwriteAndPublishRollback(sandbox);
    await testInputHardening(sandbox);
    console.log('encrypted chunk writer smoke test passed');
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}

async function testMultiFileEmptyAndAtomicPublish(sandbox) {
  const alpha = Buffer.from('alpha payload');
  const beta = Buffer.from('beta');
  const fixture = await setup(sandbox, 'happy', [
    directory('bundle'),
    file('bundle/alpha.txt', alpha),
    file('bundle/empty.bin', Buffer.alloc(0)),
    file('note.txt', beta)
  ]);
  const writer = await createWriter(fixture);

  let progress = await send(writer, fixture.manifest.taskId, 'bundle/alpha.txt', 0, 0, alpha.subarray(0, 5));
  assert.deepStrictEqual(progress.files[0], {
    path: 'bundle/alpha.txt', committedOffset: 5, completed: false
  });
  assertNoFinalTargets(fixture);

  progress = await send(writer, fixture.manifest.taskId, 'bundle/alpha.txt', 5, 1, alpha.subarray(5));
  assert.strictEqual(progress.files[0].completed, true);
  await send(writer, fixture.manifest.taskId, 'bundle/empty.bin', 0, 2, Buffer.alloc(0));
  progress = await send(writer, fixture.manifest.taskId, 'note.txt', 0, 3, beta);
  assert.ok(progress.files.every((item) => item.completed));
  assert.strictEqual(progress.nextSequence, 4);
  assertNoFinalTargets(fixture);

  const result = await writer.complete();
  assert.strictEqual(result.published, true);
  assert.strictEqual(result.cleanupPending, false);
  assert.strictEqual(result.files, 3);
  assert.strictEqual(fs.readFileSync(finalFor(fixture, 'bundle/alpha.txt'), 'utf8'), alpha.toString());
  assert.strictEqual(fs.statSync(finalFor(fixture, 'bundle/empty.bin')).size, 0);
  assert.strictEqual(fs.readFileSync(finalFor(fixture, 'note.txt'), 'utf8'), beta.toString());
  assert.strictEqual(fs.existsSync(fixture.plan.stagingDirectory), false);
  await assert.rejects(writer.writeChunk(sealChunk({
    taskId: fixture.manifest.taskId,
    path: 'note.txt', offset: 0, sequence: 0, plaintext: beta
  })), /published/i);
}

async function testStrictOrderingAndBounds(sandbox) {
  await expectRejectedChunk(sandbox, 'wrong-task', { taskId: nextTaskId() }, /taskId/i);
  await expectRejectedChunk(sandbox, 'wrong-path', { path: 'other.txt' }, /out of order/i);
  await expectRejectedChunk(sandbox, 'wrong-offset', { offset: 1 }, /offset/i);
  await expectRejectedChunk(sandbox, 'skipped-sequence', { sequence: 1 }, /sequence/i);
  await expectRejectedChunk(sandbox, 'zero-nonempty', { plaintext: Buffer.alloc(0), plainLength: 0 }, /zero-length/i);
  await expectRejectedChunk(sandbox, 'past-end', { plaintext: Buffer.from('abcdef'), plainLength: 6 }, /manifest file size/i);

  const fixture = await setup(sandbox, 'duplicate-sequence', [file('data.bin', Buffer.from('abcd'))]);
  const writer = await createWriter(fixture);
  await send(writer, fixture.manifest.taskId, 'data.bin', 0, 0, Buffer.from('ab'));
  await assert.rejects(
    writer.writeChunk(sealChunk({
      taskId: fixture.manifest.taskId,
      path: 'data.bin', offset: 2, sequence: 0, plaintext: Buffer.from('cd')
    })),
    /sequence/i
  );
  assert.strictEqual(fs.existsSync(finalFor(fixture, 'data.bin')), false);
  await cleanupFixture(fixture);

  const emptyFixture = await setup(sandbox, 'empty-marker', [file('empty', Buffer.alloc(0))]);
  const emptyWriter = await createWriter(emptyFixture);
  await send(emptyWriter, emptyFixture.manifest.taskId, 'empty', 0, 0, Buffer.alloc(0));
  await assert.rejects(
    emptyWriter.writeChunk(sealChunk({
      taskId: emptyFixture.manifest.taskId,
      path: 'empty', offset: 0, sequence: 1, plaintext: Buffer.alloc(0)
    })),
    /already complete/i
  );
  await cleanupFixture(emptyFixture);
}

async function testAuthenticationFailureAndSafeProgress(sandbox) {
  const fixture = await setup(sandbox, 'auth-failure', [file('secret.bin', Buffer.from('secret'))]);
  const inputKey = Buffer.from(SESSION_KEY);
  const writer = await createEncryptedChunkWriter({
    manifest: fixture.manifest,
    plan: fixture.plan,
    sessionKey: inputKey
  });
  const chunk = sealChunk({
    taskId: fixture.manifest.taskId,
    path: 'secret.bin', offset: 0, sequence: 0, plaintext: Buffer.from('secret')
  });
  chunk.authTag[0] ^= 0xff;
  await assert.rejects(writer.writeChunk(chunk), /authentication failed|authenticate encrypted chunk/i);
  assert.deepStrictEqual(inputKey, SESSION_KEY, 'caller-owned key must not be mutated');
  assert.strictEqual(fs.existsSync(finalFor(fixture, 'secret.bin')), false);

  const progress = writer.getCommittedProgress();
  assert.deepStrictEqual(progress.files, [
    { path: 'secret.bin', committedOffset: 0, completed: false }
  ]);
  const serialized = JSON.stringify(progress);
  assert.ok(!serialized.includes(fixture.receiveRoot));
  assert.ok(!serialized.includes(SESSION_KEY.toString('hex')));
  assert.deepStrictEqual(Object.keys(progress).sort(), ['files', 'nextSequence']);
  await assert.rejects(writer.complete(), /failed/i);
  await cleanupFixture(fixture);
}

async function testResumeTruncatesUncommittedTail(sandbox) {
  const payload = Buffer.from('abcdef');
  const fixture = await setup(sandbox, 'resume', [file('resume.bin', payload)]);
  const first = await createWriter(fixture);
  const progress = await send(first, fixture.manifest.taskId, 'resume.bin', 0, 0, payload.subarray(0, 3));
  await first.cancel();
  fs.appendFileSync(stagingFor(fixture, 'resume.bin'), 'uncommitted-tail');

  const second = await createEncryptedChunkWriter({
    manifest: fixture.manifest,
    plan: fixture.plan,
    resumeProgress: progress,
    sessionKey: SESSION_KEY
  });
  assert.strictEqual(fs.statSync(stagingFor(fixture, 'resume.bin')).size, 3);
  const resumed = await send(second, fixture.manifest.taskId, 'resume.bin', 3, 1, payload.subarray(3));
  assert.strictEqual(resumed.files[0].completed, true);
  await second.complete();
  assert.deepStrictEqual(fs.readFileSync(finalFor(fixture, 'resume.bin')), payload);
}

async function testHashMismatchNeverPublishes(sandbox) {
  const fixture = await setup(sandbox, 'hash-mismatch', [file('hash.bin', Buffer.from('good'))]);
  const writer = await createWriter(fixture);
  await assert.rejects(
    send(writer, fixture.manifest.taskId, 'hash.bin', 0, 0, Buffer.from('evil')),
    /does not match manifest/i
  );
  assert.strictEqual(fs.existsSync(finalFor(fixture, 'hash.bin')), false);
  assert.strictEqual(fs.statSync(stagingFor(fixture, 'hash.bin')).size, 0);
  assert.deepStrictEqual(writer.getCommittedProgress().files[0], {
    path: 'hash.bin', committedOffset: 0, completed: false
  });
  await cleanupFixture(fixture);
}

async function testWriteFailureRollsBackUncommittedBytes(sandbox) {
  const payload = Buffer.from('write-failure');
  const fixture = await setup(sandbox, 'write-failure', [file('write.bin', payload)]);
  const target = stagingFor(fixture, 'write.bin');
  let injected = false;
  const fsPromises = wrapFsPromises({
    async open(filePath, flags, mode) {
      const handle = await fs.promises.open(filePath, flags, mode);
      if (filePath !== target || injected || (flags & fs.constants.O_EXCL) === 0) return handle;
      injected = true;
      let failed = false;
      return wrapHandle(handle, {
        async write(buffer, offset, length, position) {
          if (!failed) {
            failed = true;
            const partial = Math.max(1, Math.floor(length / 2));
            await handle.write(buffer, offset, partial, position);
            throw new Error('injected disk write failure');
          }
          return handle.write(buffer, offset, length, position);
        }
      });
    }
  });
  const writer = await createEncryptedChunkWriter({
    fsPromises,
    manifest: fixture.manifest,
    plan: fixture.plan,
    sessionKey: SESSION_KEY
  });
  await assert.rejects(
    send(writer, fixture.manifest.taskId, 'write.bin', 0, 0, payload),
    /injected disk write failure/i
  );
  assert.strictEqual(fs.existsSync(finalFor(fixture, 'write.bin')), false);
  assert.strictEqual(fs.statSync(target).size, 0);
  assert.strictEqual(writer.getCommittedProgress().files[0].committedOffset, 0);
  await cleanupFixture(fixture);
}

async function testAbortAndExplicitCancel(sandbox) {
  const aborted = await setup(sandbox, 'abort', [file('abort.bin', Buffer.from('abort'))]);
  const controller = new AbortController();
  const writer = await createEncryptedChunkWriter({
    manifest: aborted.manifest,
    plan: aborted.plan,
    sessionKey: SESSION_KEY,
    signal: controller.signal
  });
  controller.abort(new Error('test cancellation'));
  await assert.rejects(
    send(writer, aborted.manifest.taskId, 'abort.bin', 0, 0, Buffer.from('abort')),
    /cancelled/i
  );
  assert.strictEqual(fs.existsSync(finalFor(aborted, 'abort.bin')), false);
  await cleanupFixture(aborted);

  const cancelled = await setup(sandbox, 'cancel', [file('cancel.bin', Buffer.from('cancel'))]);
  const cancelWriter = await createWriter(cancelled);
  const progress = await cancelWriter.cancel();
  assert.strictEqual(progress.files[0].committedOffset, 0);
  await assert.rejects(cancelWriter.complete(), /cancelled/i);
  assertNoFinalTargets(cancelled);
  await cleanupFixture(cancelled);
}

async function testSymlinkJunctionAndUnexpectedEntryDefense(sandbox) {
  const symlinkFixture = await setup(sandbox, 'symlink', [
    directory('folder'),
    file('folder/file.bin', Buffer.from('safe'))
  ]);
  const symlinkWriter = await createWriter(symlinkFixture);
  const outside = path.join(sandbox, 'outside-sentinel.txt');
  fs.writeFileSync(outside, 'keep');
  const stagingFile = stagingFor(symlinkFixture, 'folder/file.bin');
  let linked = false;
  try {
    fs.symlinkSync(outside, stagingFile, 'file');
    linked = true;
  } catch (error) {
    if (!['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) throw error;
  }
  if (linked) {
    await assert.rejects(
      send(symlinkWriter, symlinkFixture.manifest.taskId, 'folder/file.bin', 0, 0, Buffer.from('safe')),
      /already exists|symbolic link|regular file/i
    );
    assert.strictEqual(fs.readFileSync(outside, 'utf8'), 'keep');
    fs.rmSync(stagingFile, { force: true });
  } else {
    await symlinkWriter.cancel();
  }
  await cleanupFixture(symlinkFixture);

  const unexpected = await setup(sandbox, 'unexpected-entry', [file('ok.bin', Buffer.from('ok'))]);
  const unexpectedWriter = await createWriter(unexpected);
  await send(unexpectedWriter, unexpected.manifest.taskId, 'ok.bin', 0, 0, Buffer.from('ok'));
  fs.writeFileSync(path.join(unexpected.plan.stagingDirectory, 'injected.txt'), 'injected');
  await assert.rejects(unexpectedWriter.complete(), /unexpected entry/i);
  assert.strictEqual(fs.existsSync(finalFor(unexpected, 'ok.bin')), false);
  await cleanupFixture(unexpected);
}

async function testNoOverwriteAndPublishRollback(sandbox) {
  const conflict = await setup(sandbox, 'publish-conflict', [file('conflict.bin', Buffer.from('new'))]);
  const conflictWriter = await createWriter(conflict);
  await send(conflictWriter, conflict.manifest.taskId, 'conflict.bin', 0, 0, Buffer.from('new'));
  fs.writeFileSync(finalFor(conflict, 'conflict.bin'), 'existing');
  await assert.rejects(conflictWriter.complete(), /appeared|already exists|overwrite/i);
  assert.strictEqual(fs.readFileSync(finalFor(conflict, 'conflict.bin'), 'utf8'), 'existing');
  await cleanupFixture(conflict);

  const rollback = await setup(sandbox, 'publish-rollback', [
    directory('one'),
    file('one/a.txt', Buffer.from('a')),
    directory('two'),
    file('two/b.txt', Buffer.from('b'))
  ]);
  let publicationRenames = 0;
  const fsPromises = wrapFsPromises({
    async rename(source, destination) {
      if (source.startsWith(rollback.plan.stagingDirectory + path.sep)) {
        publicationRenames += 1;
        if (publicationRenames === 2) throw new Error('injected second-root publish failure');
      }
      return fs.promises.rename(source, destination);
    }
  });
  const rollbackWriter = await createEncryptedChunkWriter({
    fsPromises,
    manifest: rollback.manifest,
    plan: rollback.plan,
    sessionKey: SESSION_KEY
  });
  await send(rollbackWriter, rollback.manifest.taskId, 'one/a.txt', 0, 0, Buffer.from('a'));
  await send(rollbackWriter, rollback.manifest.taskId, 'two/b.txt', 0, 1, Buffer.from('b'));
  await assert.rejects(rollbackWriter.complete(), /second-root publish failure/i);
  assert.strictEqual(fs.existsSync(finalFor(rollback, 'one')), false);
  assert.strictEqual(fs.existsSync(finalFor(rollback, 'two')), false);
  assert.strictEqual(fs.readFileSync(stagingFor(rollback, 'one/a.txt'), 'utf8'), 'a');
  assert.strictEqual(fs.readFileSync(stagingFor(rollback, 'two/b.txt'), 'utf8'), 'b');
  await cleanupFixture(rollback);
}

async function testInputHardening(sandbox) {
  const fixture = await setup(sandbox, 'input-hardening', [file('safe.bin', Buffer.from('safe'))]);
  const tamperedPlan = {
    ...fixture.plan,
    stagingDirectory: path.join(sandbox, 'outside-staging')
  };
  await assert.rejects(createEncryptedChunkWriter({
    manifest: fixture.manifest,
    plan: tamperedPlan,
    sessionKey: SESSION_KEY
  }), /planner-owned/i);

  const accessorChunk = {};
  Object.defineProperty(accessorChunk, 'taskId', { enumerable: true, get() { return fixture.manifest.taskId; } });
  for (const [key, value] of Object.entries({
    path: 'safe.bin', offset: 0, sequence: 0, plainLength: 4,
    nonce: Buffer.alloc(12), ciphertext: Buffer.alloc(4), authTag: Buffer.alloc(16)
  })) accessorChunk[key] = value;
  const writer = await createWriter(fixture);
  await assert.rejects(writer.writeChunk(accessorChunk), /data properties/i);
  await cleanupFixture(fixture);

  const badProgressFixture = await setup(sandbox, 'bad-progress', [
    file('a.bin', Buffer.from('a')),
    file('b.bin', Buffer.from('b'))
  ]);
  await assert.rejects(createEncryptedChunkWriter({
    manifest: badProgressFixture.manifest,
    plan: badProgressFixture.plan,
    resumeProgress: {
      nextSequence: 1,
      files: [
        { path: 'a.bin', committedOffset: 0, completed: false },
        { path: 'b.bin', committedOffset: 1, completed: true }
      ]
    },
    sessionKey: SESSION_KEY
  }), /completed prefix/i);
  await cleanupFixture(badProgressFixture);
}

async function expectRejectedChunk(sandbox, name, changes, pattern) {
  const payload = Buffer.from('abcde');
  const fixture = await setup(sandbox, name, [file('data.bin', payload)]);
  const writer = await createWriter(fixture);
  const taskId = changes.taskId || fixture.manifest.taskId;
  const relativePath = changes.path || 'data.bin';
  const offset = changes.offset === undefined ? 0 : changes.offset;
  const sequence = changes.sequence === undefined ? 0 : changes.sequence;
  const plaintext = changes.plaintext === undefined ? payload : changes.plaintext;
  const chunk = sealChunk({
    taskId,
    path: relativePath,
    offset,
    sequence,
    plaintext
  });
  if (changes.plainLength !== undefined) chunk.plainLength = changes.plainLength;
  await assert.rejects(writer.writeChunk(chunk), pattern);
  assertNoFinalTargets(fixture);
  await cleanupFixture(fixture);
}

async function setup(sandbox, name, entries) {
  const receiveRoot = path.join(sandbox, name);
  fs.mkdirSync(receiveRoot);
  const manifest = createTransferManifest({ taskId: nextTaskId(), entries });
  const plan = await planReceiveTargets({ manifest, receiveRoot });
  return { manifest, plan, receiveRoot };
}

function directory(relativePath) {
  return { kind: 'directory', path: relativePath };
}

function file(relativePath, bytes) {
  return {
    kind: 'file',
    path: relativePath,
    size: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex')
  };
}

function nextTaskId() {
  taskCounter += 1;
  return Buffer.alloc(16, taskCounter).toString('base64url');
}

function createWriter(fixture, options = {}) {
  return createEncryptedChunkWriter({
    manifest: fixture.manifest,
    plan: fixture.plan,
    sessionKey: SESSION_KEY,
    ...options
  });
}

function sealChunk({ taskId, path: relativePath, offset, sequence, plaintext }) {
  const encrypted = encryptChunk({
    key: SESSION_KEY,
    taskId,
    path: relativePath,
    offset,
    sequence,
    plaintext
  });
  return {
    taskId,
    path: relativePath,
    offset,
    sequence,
    plainLength: plaintext.length,
    nonce: encrypted.nonce,
    ciphertext: encrypted.ciphertext,
    authTag: encrypted.authTag
  };
}

function send(writer, taskId, relativePath, offset, sequence, plaintext) {
  return writer.writeChunk(sealChunk({ taskId, path: relativePath, offset, sequence, plaintext }));
}

function targetFor(fixture, relativePath) {
  const target = fixture.plan.targets.find((candidate) => candidate.path === relativePath);
  assert.ok(target, `missing target ${relativePath}`);
  return target;
}

function stagingFor(fixture, relativePath) {
  return targetFor(fixture, relativePath).stagingPath;
}

function finalFor(fixture, relativePath) {
  return targetFor(fixture, relativePath).finalPath;
}

function assertNoFinalTargets(fixture) {
  const roots = new Set(fixture.plan.targets.map((target) => {
    const relative = path.relative(fixture.receiveRoot, target.finalPath);
    return path.join(fixture.receiveRoot, relative.split(path.sep)[0]);
  }));
  for (const root of roots) assert.strictEqual(fs.existsSync(root), false, `unexpected published root: ${root}`);
}

async function cleanupFixture(fixture) {
  try {
    await cleanupReceiveStaging({ receiveRoot: fixture.receiveRoot, taskId: fixture.manifest.taskId });
  } catch (error) {
    if (fs.existsSync(fixture.plan.stagingDirectory)) {
      for (const entry of fs.readdirSync(fixture.plan.stagingDirectory, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) fs.rmSync(path.join(fixture.plan.stagingDirectory, entry.name), { force: true });
      }
    }
    throw error;
  }
}

function wrapFsPromises(overrides) {
  const wrapped = {};
  for (const method of ['link', 'lstat', 'mkdir', 'open', 'readdir', 'rename', 'rm', 'rmdir', 'unlink']) {
    wrapped[method] = overrides[method] || ((...args) => fs.promises[method](...args));
  }
  return wrapped;
}

function wrapHandle(handle, overrides) {
  const wrapped = {};
  for (const method of ['close', 'read', 'stat', 'sync', 'truncate', 'write']) {
    wrapped[method] = overrides[method] || ((...args) => handle[method](...args));
  }
  return wrapped;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

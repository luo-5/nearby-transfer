import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createEncryptedChunkWriter,
  createTransferManifest,
  encryptChunk,
  planReceiveTargets,
} from '../src/index.js';

function proxyFs(overrides: Partial<typeof fs.promises>): typeof fs.promises {
  return new Proxy(fs.promises, {
    get(target, property) {
      const replacement = overrides[property as keyof typeof overrides];
      if (replacement) return replacement;
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function preparedWriter(receiveRoot: string, payload: Buffer, fsPromises: typeof fs.promises = fs.promises) {
  const sha256 = crypto.createHash('sha256').update(payload).digest('hex');
  const manifest = createTransferManifest({
    entries: [{ kind: 'file', path: 'note.txt', size: payload.length, sha256 }],
  });
  const plan = await planReceiveTargets({ manifest, receiveRoot });
  const sessionKey = crypto.randomBytes(32);
  const encrypted = encryptChunk({
    key: sessionKey,
    taskId: manifest.taskId,
    path: 'note.txt',
    offset: 0,
    sequence: 0,
    plaintext: payload,
  });
  const writer = await createEncryptedChunkWriter({ manifest, plan, sessionKey, fsPromises });
  await writer.writeChunk({
    taskId: manifest.taskId,
    path: 'note.txt',
    offset: 0,
    sequence: 0,
    plainLength: payload.length,
    nonce: encrypted.nonce,
    authTag: encrypted.authTag,
    ciphertext: encrypted.ciphertext,
  });
  return { writer, plan };
}

test('encrypted writer publishes to the planner auto-rename target', async () => {
  const receiveRoot = mkdtempSync(join(tmpdir(), 'nearby-writer-rename-'));
  try {
    writeFileSync(join(receiveRoot, 'note.txt'), 'existing');
    const payload = Buffer.from('incoming');
    const { writer, plan } = await preparedWriter(receiveRoot, payload);
    assert.equal(plan.targets[0]!.finalPath, join(receiveRoot, 'note (1).txt'));
    await writer.complete();
    assert.equal(readFileSync(join(receiveRoot, 'note.txt'), 'utf8'), 'existing');
    assert.deepEqual(readFileSync(join(receiveRoot, 'note (1).txt')), payload);
  } finally {
    rmSync(receiveRoot, { recursive: true, force: true });
  }
});

test('encrypted writer re-verifies the published link after a late staging change', async () => {
  const receiveRoot = mkdtempSync(join(tmpdir(), 'nearby-writer-identity-'));
  try {
    const payload = Buffer.from('GOOD');
    let injected = false;
    const fsPromises = proxyFs({
      link: async (existingPath, newPath) => {
        if (!injected) {
          injected = true;
          await fs.promises.writeFile(existingPath, Buffer.from('EVIL'));
        }
        return fs.promises.link(existingPath, newPath);
      },
    });
    const { writer, plan } = await preparedWriter(receiveRoot, payload, fsPromises);
    await assert.rejects(writer.complete(), /does not match manifest|integrity|verification/i);
    assert.equal(fs.existsSync(plan.targets[0]!.finalPath), false);
  } finally {
    rmSync(receiveRoot, { recursive: true, force: true });
  }
});

test('encrypted writer reports success after publication when only staging-link cleanup is delayed', async () => {
  const receiveRoot = mkdtempSync(join(tmpdir(), 'nearby-writer-cleanup-'));
  try {
    const payload = Buffer.from('published');
    let injected = false;
    const fsPromises = proxyFs({
      unlink: async (targetPath) => {
        if (!injected && String(targetPath).includes('.nearby-transfer-staging-')) {
          injected = true;
          const error = new Error('injected staging unlink delay') as NodeJS.ErrnoException;
          error.code = 'EPERM';
          throw error;
        }
        return fs.promises.unlink(targetPath);
      },
    });
    const { writer, plan } = await preparedWriter(receiveRoot, payload, fsPromises);
    const result = await writer.complete();
    assert.equal(result.published, true);
    assert.deepEqual(readFileSync(plan.targets[0]!.finalPath), payload);
  } finally {
    rmSync(receiveRoot, { recursive: true, force: true });
  }
});

test('encrypted writer fails closed when hard-link publication is unavailable', async () => {
  const receiveRoot = mkdtempSync(join(tmpdir(), 'nearby-writer-copy-fallback-'));
  try {
    const payload = Buffer.from('copy-fallback');
    const fsPromises = proxyFs({
      link: async () => {
        const error = new Error('hard links unavailable') as NodeJS.ErrnoException;
        error.code = 'ENOTSUP';
        throw error;
      },
    });
    const { writer, plan } = await preparedWriter(receiveRoot, payload, fsPromises);
    await assert.rejects(writer.complete(), /requires hard-link support/);
    assert.equal(fs.existsSync(plan.targets[0]!.finalPath), false);
    assert.equal(fs.existsSync(plan.targets[0]!.stagingPath), true);
  } finally {
    rmSync(receiveRoot, { recursive: true, force: true });
  }
});

test('cancel before the publication commit point rolls back an already-created final exactly once', async () => {
  const receiveRoot = mkdtempSync(join(tmpdir(), 'nearby-writer-precommit-cancel-'));
  const verificationEntered = deferred();
  const releaseVerification = deferred();
  let finalPath = '';
  let verificationBlocked = false;
  let finalRollbacks = 0;
  const fsPromises = proxyFs({
    open: (async (...args: unknown[]) => {
      const targetPath = String(args[0]);
      if (!verificationBlocked && finalPath && targetPath === finalPath) {
        verificationBlocked = true;
        verificationEntered.resolve();
        await releaseVerification.promise;
      }
      return (fs.promises.open as (...openArgs: unknown[]) => ReturnType<typeof fs.promises.open>)(...args);
    }) as typeof fs.promises.open,
    unlink: (async (targetPath: fs.PathLike) => {
      if (finalPath && String(targetPath) === finalPath) finalRollbacks += 1;
      return fs.promises.unlink(targetPath);
    }) as typeof fs.promises.unlink,
  });

  try {
    const payload = Buffer.from('cancel-before-commit');
    const { writer, plan } = await preparedWriter(receiveRoot, payload, fsPromises);
    finalPath = plan.targets[0]!.finalPath;
    const completion = writer.complete();
    await verificationEntered.promise;
    assert.equal(fs.existsSync(finalPath), true, 'the filesystem gate must pause after the final link exists');

    const firstCancel = writer.cancel();
    const secondCancel = writer.cancel();
    releaseVerification.resolve();

    await assert.rejects(completion, (error: Error) => error.name === 'AbortError');
    const [firstProgress, secondProgress] = await Promise.all([firstCancel, secondCancel]);
    assert.deepEqual(firstProgress, secondProgress);
    assert.equal(finalRollbacks, 1);
    assert.equal(fs.existsSync(finalPath), false);
    assert.equal(fs.existsSync(plan.targets[0]!.stagingPath), true);
    assert.deepEqual(await writer.cancel(), firstProgress);
  } finally {
    releaseVerification.resolve();
    rmSync(receiveRoot, { recursive: true, force: true });
  }
});

test('cancel after the publication commit point is idempotent while cleanup is still active', async () => {
  const receiveRoot = mkdtempSync(join(tmpdir(), 'nearby-writer-postcommit-cancel-'));
  const cleanupEntered = deferred();
  const releaseCleanup = deferred();
  let stagingDirectory = '';
  let cleanupBlocked = false;
  const fsPromises = proxyFs({
    rm: (async (...args: unknown[]) => {
      const targetPath = String(args[0]);
      if (!cleanupBlocked && stagingDirectory && targetPath === stagingDirectory) {
        cleanupBlocked = true;
        cleanupEntered.resolve();
        await releaseCleanup.promise;
      }
      return (fs.promises.rm as (...rmArgs: unknown[]) => ReturnType<typeof fs.promises.rm>)(...args);
    }) as typeof fs.promises.rm,
  });

  try {
    const payload = Buffer.from('cancel-after-commit');
    const { writer, plan } = await preparedWriter(receiveRoot, payload, fsPromises);
    stagingDirectory = plan.stagingDirectory;
    const completion = writer.complete();
    await cleanupEntered.promise;
    assert.deepEqual(readFileSync(plan.targets[0]!.finalPath), payload);

    let settledCancels = 0;
    const firstCancel = writer.cancel().then((progress) => { settledCancels += 1; return progress; });
    const secondCancel = writer.cancel().then((progress) => { settledCancels += 1; return progress; });
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(settledCancels, 2, 'post-commit cancellation must not wait for or disturb active cleanup');

    releaseCleanup.resolve();
    const [result, firstProgress, secondProgress] = await Promise.all([completion, firstCancel, secondCancel]);
    assert.equal(result.published, true);
    assert.deepEqual(firstProgress, result.progress);
    assert.deepEqual(secondProgress, result.progress);
    assert.deepEqual(await writer.cancel(), result.progress);
  } finally {
    releaseCleanup.resolve();
    rmSync(receiveRoot, { recursive: true, force: true });
  }
});

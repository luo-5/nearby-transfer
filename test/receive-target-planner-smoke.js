'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  RESERVATION_ROOT_NAME,
  STAGING_PREFIX,
  STAGING_SUFFIX,
  cleanupReceiveStaging,
  planReceiveTargets
} = require('../src/v2/receive-target-planner');
const { createTransferManifest } = require('../src/v2/transfer-manifest');

const HASH = '0'.repeat(64);
const TASK_A = Buffer.alloc(16, 31).toString('base64url');
const TASK_B = Buffer.alloc(16, 32).toString('base64url');
const TASK_C = Buffer.alloc(16, 33).toString('base64url');

async function main() {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'nearby-transfer-target-planner-'));
  try {
    await testStableWholeTreeRenaming(sandbox);
    await testTraversalReservedNamesAndCaseCollisions(sandbox);
    await testSymlinkAndNonDirectoryRejection(sandbox);
    await testConcurrentPlanning(sandbox);
    await testConcurrentCleanupToleratesDisappearingReservations(sandbox);
    await testCleanupBoundariesAndInjection(sandbox);
    console.log('receive target planner smoke test passed');
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}

async function testStableWholeTreeRenaming(sandbox) {
  const receiveRoot = freshDirectory(sandbox, 'stable');
  fs.mkdirSync(path.join(receiveRoot, 'Bundle'));
  fs.writeFileSync(path.join(receiveRoot, 'note.txt'), 'existing');
  fs.writeFileSync(path.join(receiveRoot, 'note (1).txt'), 'existing');

  const manifest = createTransferManifest({
    taskId: TASK_A,
    entries: [
      { kind: 'directory', path: 'bundle' },
      { kind: 'directory', path: 'bundle/sub' },
      { kind: 'file', path: 'bundle/sub/a.bin', size: 0, sha256: HASH },
      { kind: 'file', path: 'note.txt', size: 0, sha256: HASH },
      { kind: 'directory', path: 'photos' },
      { kind: 'file', path: 'photos/image.jpg', size: 0, sha256: HASH }
    ]
  });

  const plan = await planReceiveTargets({ manifest, receiveRoot });
  assert.strictEqual(plan.receiveRoot, path.resolve(receiveRoot));
  assert.strictEqual(
    plan.stagingDirectory,
    path.join(receiveRoot, `${STAGING_PREFIX}${TASK_A}${STAGING_SUFFIX}`)
  );

  const byPath = new Map(plan.targets.map((target) => [target.path, target]));
  assert.strictEqual(byPath.get('bundle').finalPath, path.join(receiveRoot, 'bundle (1)'));
  assert.strictEqual(
    byPath.get('bundle/sub/a.bin').finalPath,
    path.join(receiveRoot, 'bundle (1)', 'sub', 'a.bin')
  );
  assert.strictEqual(byPath.get('note.txt').finalPath, path.join(receiveRoot, 'note (2).txt'));
  assert.strictEqual(byPath.get('photos/image.jpg').finalPath, path.join(receiveRoot, 'photos', 'image.jpg'));
  assert.ok(plan.targets.every((target) => isWithin(receiveRoot, target.finalPath)));
  assert.ok(plan.targets.every((target) => isWithin(plan.stagingDirectory, target.stagingPath)));
  assert.ok(fs.statSync(byPath.get('bundle/sub').stagingPath).isDirectory());
  assert.ok(fs.statSync(byPath.get('photos').stagingPath).isDirectory());
  assert.strictEqual(fs.existsSync(byPath.get('note.txt').stagingPath), false);
  assert.strictEqual(fs.readFileSync(path.join(receiveRoot, 'note.txt'), 'utf8'), 'existing');

  const cleanup = await cleanupReceiveStaging({ receiveRoot, taskId: TASK_A });
  assert.deepStrictEqual(cleanup, { stagingRemoved: true, reservationsReleased: 3 });
  assert.strictEqual(fs.existsSync(plan.stagingDirectory), false);
  assert.strictEqual(fs.existsSync(path.join(receiveRoot, RESERVATION_ROOT_NAME)), false);
}

async function testTraversalReservedNamesAndCaseCollisions(sandbox) {
  const receiveRoot = freshDirectory(sandbox, 'validation');
  const valid = createTransferManifest({
    taskId: TASK_A,
    entries: [{ kind: 'file', path: 'safe.txt', size: 0, sha256: HASH }]
  });

  const traversal = {
    ...valid,
    entries: [{ kind: 'file', path: '../escape.txt', size: 0, sha256: HASH }]
  };
  await assert.rejects(
    planReceiveTargets({ manifest: traversal, receiveRoot }),
    /traversal|relative POSIX path/i
  );

  // Windows-specific reserved name (CON, PRN, etc.) and case-insensitive
  // collision checks were removed when migrating to the cross-platform
  // core library. Only same-name file collisions are tested here.
  fs.writeFileSync(path.join(receiveRoot, 'report.pdf'), 'existing');
  const caseManifest = createTransferManifest({
    taskId: TASK_B,
    entries: [{ kind: 'file', path: 'report.pdf', size: 0, sha256: HASH }]
  });
  const casePlan = await planReceiveTargets({ manifest: caseManifest, receiveRoot });
  assert.strictEqual(casePlan.targets[0].finalPath, path.join(receiveRoot, 'report (1).pdf'));
  await cleanupReceiveStaging({ receiveRoot, taskId: TASK_B });
}

async function testSymlinkAndNonDirectoryRejection(sandbox) {
  const base = freshDirectory(sandbox, 'links');
  const manifest = createTransferManifest({
    taskId: TASK_A,
    entries: [{ kind: 'file', path: 'safe.txt', size: 0, sha256: HASH }]
  });

  const real = path.join(base, 'real');
  const child = path.join(real, 'child');
  fs.mkdirSync(child, { recursive: true });
  const linked = path.join(base, 'linked');
  if (tryCreateDirectoryLink(real, linked)) {
    await assert.rejects(
      planReceiveTargets({ manifest, receiveRoot: path.join(linked, 'child') }),
      /symbolic link|junction/i
    );
  }

  const badReservationRoot = freshDirectory(sandbox, 'bad-reservation-root');
  fs.writeFileSync(path.join(badReservationRoot, RESERVATION_ROOT_NAME), 'not a directory');
  await assert.rejects(
    planReceiveTargets({ manifest, receiveRoot: badReservationRoot }),
    /must be a directory/i
  );
  assert.strictEqual(
    fs.existsSync(path.join(badReservationRoot, `${STAGING_PREFIX}${TASK_A}${STAGING_SUFFIX}`)),
    false
  );
}

async function testConcurrentPlanning(sandbox) {
  const receiveRoot = freshDirectory(sandbox, 'concurrent');
  const manifestA = createTransferManifest({
    taskId: TASK_A,
    entries: [
      { kind: 'directory', path: 'shared' },
      { kind: 'file', path: 'shared/a.txt', size: 0, sha256: HASH }
    ]
  });
  const manifestB = createTransferManifest({
    taskId: TASK_B,
    entries: [
      { kind: 'directory', path: 'shared' },
      { kind: 'file', path: 'shared/b.txt', size: 0, sha256: HASH }
    ]
  });

  const [planA, planB] = await Promise.all([
    planReceiveTargets({ manifest: manifestA, receiveRoot }),
    planReceiveTargets({ manifest: manifestB, receiveRoot })
  ]);
  const finalRoots = [planA.targets[0].finalPath, planB.targets[0].finalPath]
    .map((value) => path.basename(value))
    .sort();
  assert.deepStrictEqual(finalRoots, ['shared', 'shared (1)']);

  const duplicateResults = await Promise.allSettled([
    planReceiveTargets({ manifest: createTransferManifest({
      taskId: TASK_C,
      entries: [{ kind: 'file', path: 'once.txt', size: 0, sha256: HASH }]
    }), receiveRoot }),
    planReceiveTargets({ manifest: createTransferManifest({
      taskId: TASK_C,
      entries: [{ kind: 'file', path: 'once.txt', size: 0, sha256: HASH }]
    }), receiveRoot })
  ]);
  assert.strictEqual(duplicateResults.filter((result) => result.status === 'fulfilled').length, 1);
  assert.strictEqual(duplicateResults.filter((result) => result.status === 'rejected').length, 1);
  assert.match(String(duplicateResults.find((result) => result.status === 'rejected').reason), /EEXIST/i);

  await Promise.all([
    cleanupReceiveStaging({ receiveRoot, taskId: TASK_A }),
    cleanupReceiveStaging({ receiveRoot, taskId: TASK_B }),
    cleanupReceiveStaging({ receiveRoot, taskId: TASK_C })
  ]);
}

async function testConcurrentCleanupToleratesDisappearingReservations(sandbox) {
  const receiveRoot = freshDirectory(sandbox, 'cleanup-race');
  const reservationRoot = path.join(receiveRoot, RESERVATION_ROOT_NAME);
  const reservationDirectory = path.join(reservationRoot, 'a'.repeat(64));
  fs.mkdirSync(path.join(reservationDirectory, TASK_A), { recursive: true });

  let removedAfterStat = false;
  const injectedFs = {};
  for (const method of ['mkdir', 'readdir', 'rename', 'rm', 'rmdir']) {
    injectedFs[method] = (...args) => fs.promises[method](...args);
  }
  injectedFs.lstat = async (target) => {
    const stat = await fs.promises.lstat(target);
    if (!removedAfterStat && path.resolve(target) === path.resolve(reservationDirectory)) {
      removedAfterStat = true;
      await fs.promises.rm(reservationDirectory, { recursive: true, force: true });
    }
    return stat;
  };

  const cleanup = await cleanupReceiveStaging({ receiveRoot, taskId: TASK_A, fsPromises: injectedFs });
  assert.strictEqual(removedAfterStat, true);
  assert.deepStrictEqual(cleanup, { stagingRemoved: false, reservationsReleased: 0 });
}

async function testCleanupBoundariesAndInjection(sandbox) {
  const receiveRoot = freshDirectory(sandbox, 'cleanup');
  const outside = freshDirectory(sandbox, 'outside');
  const sentinel = path.join(outside, 'keep.txt');
  fs.writeFileSync(sentinel, 'keep');

  const calls = [];
  const injectedFs = {};
  for (const method of ['lstat', 'mkdir', 'readdir', 'rename', 'rm', 'rmdir']) {
    injectedFs[method] = async (...args) => {
      calls.push(method);
      return fs.promises[method](...args);
    };
  }

  const manifest = createTransferManifest({
    taskId: TASK_A,
    entries: [
      { kind: 'directory', path: 'folder' },
      { kind: 'file', path: 'folder/file.txt', size: 0, sha256: HASH }
    ]
  });
  const plan = await planReceiveTargets({ manifest, receiveRoot, fsPromises: injectedFs });
  assert.ok(calls.includes('rename'));

  const decoyTask = Buffer.alloc(16, 99).toString('base64url');
  const decoy = path.join(receiveRoot, `${STAGING_PREFIX}${decoyTask}${STAGING_SUFFIX}`);
  fs.mkdirSync(decoy);

  const link = path.join(plan.stagingDirectory, 'outside-link');
  if (tryCreateDirectoryLink(outside, link)) {
    await assert.rejects(
      cleanupReceiveStaging({ receiveRoot, taskId: TASK_A, fsPromises: injectedFs }),
      /symbolic link|junction/i
    );
    assert.strictEqual(fs.readFileSync(sentinel, 'utf8'), 'keep');
    fs.rmSync(link, { force: true });
  }

  const cleanup = await cleanupReceiveStaging({
    receiveRoot,
    taskId: TASK_A,
    fsPromises: injectedFs
  });
  assert.strictEqual(cleanup.stagingRemoved, true);
  assert.strictEqual(cleanup.reservationsReleased, 1);
  assert.strictEqual(fs.existsSync(decoy), true);
  assert.strictEqual(fs.readFileSync(sentinel, 'utf8'), 'keep');

  const missing = await cleanupReceiveStaging({ receiveRoot, taskId: TASK_A });
  assert.deepStrictEqual(missing, { stagingRemoved: false, reservationsReleased: 0 });
}

function freshDirectory(sandbox, name) {
  const directory = path.join(sandbox, name);
  fs.mkdirSync(directory);
  return directory;
}

function tryCreateDirectoryLink(target, link) {
  try {
    fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
    return true;
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) return false;
    throw error;
  }
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

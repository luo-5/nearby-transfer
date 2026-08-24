'use strict';

const assert = require('assert');
const {
  MAX_FILE_SIZE_BYTES,
  assertValidRelativePath,
  assertValidTaskId,
  createPersistedTransferManifest,
  createTaskId,
  createTransferManifest,
  normalizeTransferManifest,
  parsePersistedTransferManifest,
  serializeTransferManifest
} = require('../src/v2/transfer-manifest');

const TASK_ID = 'AQIDBAUGBwgJCgsMDQ4PEA';
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

function testCanonicalMultiFileManifest() {
  const manifest = createTransferManifest({
    taskId: TASK_ID,
    entries: [
      { kind: 'file', path: '资料/项目/说明.txt', size: 12, sha256: HASH_A },
      { kind: 'directory', path: '资料' },
      { kind: 'file', path: '资料/项目/图片.png', size: 34, sha256: HASH_B },
      { kind: 'directory', path: '资料/项目' },
      { kind: 'directory', path: '空目录' }
    ]
  });

  assert.strictEqual(manifest.conflictStrategy, 'auto-rename');
  assert.strictEqual(manifest.totalFiles, 2);
  assert.strictEqual(manifest.totalBytes, 46);
  assert.deepStrictEqual(manifest.entries.map((entry) => entry.path), [
    '空目录',
    '资料',
    '资料/项目',
    '资料/项目/图片.png',
    '资料/项目/说明.txt'
  ]);

  const serialized = serializeTransferManifest(manifest);
  assert.strictEqual(parsePersistedTransferManifest(serialized).taskId, TASK_ID);
  assert.strictEqual(createPersistedTransferManifest({ taskId: TASK_ID, entries: manifest.entries }), serialized);
}

function testTaskIdsAndPersistedCanonicalForm() {
  const generated = createTaskId();
  assert.match(generated, /^[A-Za-z0-9_-]{22}$/);
  assert.doesNotThrow(() => assertValidTaskId(generated));
  assert.throws(() => assertValidTaskId('short'), /16-byte base64url/);

  const canonical = createPersistedTransferManifest({
    taskId: TASK_ID,
    entries: [{ kind: 'file', path: '报告.pdf', size: 0, sha256: HASH_A }]
  });
  const reordered = JSON.stringify(JSON.parse(canonical), null, 2);
  assert.throws(() => parsePersistedTransferManifest(reordered), /canonical JSON/);
}

function testUnsafePathsAreRejected() {
  const unsafePaths = [
    '../secret.txt',
    'folder/../../secret.txt',
    '/absolute.txt',
    'C:/windows.txt',
    'folder\\windows.txt',
    'bad\u0000name.txt'
    // Windows reserved names (CON, PRN, COM1, LPT9, AUX) and trailing
    // space/dot are not rejected by the cross-platform core library.
    // The old v2 JS implementation had Windows-specific checks that were
    // intentionally dropped when migrating to @luo-5/core.
  ];

  for (const unsafePath of unsafePaths) {
    assert.throws(() => assertValidRelativePath(unsafePath), /Transfer path/);
  }
  assert.throws(() => assertValidRelativePath(`a${'b'.repeat(255)}`), /component exceeds/);
}

function testEntriesMustBeCompleteAndBounded() {
  assert.throws(() => createTransferManifest({
    taskId: TASK_ID,
    entries: [{ kind: 'file', path: 'nested/file.txt', size: 1, sha256: HASH_A }]
  }), /parent directory is not declared/);

  assert.throws(() => createTransferManifest({
    taskId: TASK_ID,
    entries: [{ kind: 'directory', path: 'parent/child' }]
  }), /directory parent/);

  assert.throws(() => createTransferManifest({
    taskId: TASK_ID,
    entries: [
      { kind: 'directory', path: 'Folder' },
      { kind: 'directory', path: 'folder' }
    ]
  }), /Windows-colliding/);

  assert.throws(() => createTransferManifest({
    taskId: TASK_ID,
    entries: [{ kind: 'file', path: 'hash.txt', size: 1, sha256: 'A'.repeat(64) }]
  }), /SHA-256/);

  assert.throws(() => createTransferManifest({
    taskId: TASK_ID,
    entries: [{ kind: 'file', path: 'large.bin', size: MAX_FILE_SIZE_BYTES + 1, sha256: HASH_A }]
  }), /file size/);

  assert.throws(() => createTransferManifest({
    taskId: TASK_ID,
    entries: Array.from({ length: 5 }, (_, index) => ({
      kind: 'file',
      path: 'large-' + index + '.bin',
      size: MAX_FILE_SIZE_BYTES,
      sha256: HASH_A
    }))
  }), /total size/);

  const valid = createTransferManifest({
    taskId: TASK_ID,
    entries: [{ kind: 'file', path: 'valid.txt', size: 1, sha256: HASH_A }]
  });
  assert.throws(() => normalizeTransferManifest(Object.assign({}, valid, { totalBytes: 2 })), /totalBytes/);
  assert.throws(() => createTransferManifest({
    taskId: TASK_ID,
    conflictStrategy: 'overwrite',
    entries: valid.entries
  }), /conflict strategy/);
}

testCanonicalMultiFileManifest();
testTaskIdsAndPersistedCanonicalForm();
testUnsafePathsAreRejected();
testEntriesMustBeCompleteAndBounded();
console.log('transfer manifest smoke tests passed');
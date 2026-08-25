import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createTransferManifest,
  normalizeTransferManifest,
  MAX_FILE_SIZE_BYTES,
  MAX_TOTAL_SIZE_BYTES,
} from '../src/transfer/manifest.js';

describe('manifest edge tests', () => {
  const dummySha = 'a'.repeat(64);

  it('rejects empty manifest entry list', () => {
    assert.throws(() => createTransferManifest({ entries: [] }), /non-empty/i);
  });

  it('rejects absolute paths and path traversals', () => {
    assert.throws(
      () =>
        createTransferManifest({
          entries: [{ kind: 'file', path: '/etc/passwd', size: 10, sha256: dummySha }],
        }),
      /POSIX/i,
    );
    assert.throws(
      () =>
        createTransferManifest({
          entries: [{ kind: 'file', path: '../secret.txt', size: 10, sha256: dummySha }],
        }),
      /traversal/i,
    );
    assert.throws(
      () =>
        createTransferManifest({
          entries: [{ kind: 'file', path: 'dir/../../secret.txt', size: 10, sha256: dummySha }],
        }),
      /traversal/i,
    );
  });

  it('rejects duplicate or case-colliding entries', () => {
    assert.throws(
      () =>
        createTransferManifest({
          entries: [
            { kind: 'file', path: 'readme.txt', size: 10, sha256: dummySha },
            { kind: 'file', path: 'readme.txt', size: 20, sha256: dummySha },
          ],
        }),
      /duplicate/i,
    );
    assert.throws(
      () =>
        createTransferManifest({
          entries: [
            { kind: 'file', path: 'README.txt', size: 10, sha256: dummySha },
            { kind: 'file', path: 'readme.txt', size: 20, sha256: dummySha },
          ],
        }),
      /Windows-colliding/i,
    );
  });

  it('rejects files with undeclared parent directories', () => {
    assert.throws(
      () =>
        createTransferManifest({
          entries: [{ kind: 'file', path: 'sub/dir/file.txt', size: 10, sha256: dummySha }],
        }),
      /parent directory is not declared/i,
    );
  });

  it('rejects oversized file or total size', () => {
    assert.throws(
      () =>
        createTransferManifest({
          entries: [{ kind: 'file', path: 'huge.bin', size: MAX_FILE_SIZE_BYTES + 1, sha256: dummySha }],
        }),
      /size/i,
    );
    const subSize = Math.floor(MAX_FILE_SIZE_BYTES * 0.9); // 0.9 TiB each
    assert.throws(
      () =>
        createTransferManifest({
          entries: [
            { kind: 'file', path: 'a.bin', size: subSize, sha256: dummySha },
            { kind: 'file', path: 'b.bin', size: subSize, sha256: dummySha },
            { kind: 'file', path: 'c.bin', size: subSize, sha256: dummySha },
            { kind: 'file', path: 'd.bin', size: subSize, sha256: dummySha },
            { kind: 'file', path: 'e.bin', size: subSize, sha256: dummySha },
          ],
        }),
      /total size/i,
    );
  });

  it('rejects invalid SHA-256 formatting', () => {
    assert.throws(
      () =>
        createTransferManifest({
          entries: [{ kind: 'file', path: 'file.txt', size: 10, sha256: 'invalid-hash' }],
        }),
      /SHA-256/i,
    );
    assert.throws(
      () =>
        createTransferManifest({
          entries: [{ kind: 'file', path: 'file.txt', size: 10, sha256: 'A'.repeat(64) }], // Uppercase not allowed
        }),
      /SHA-256/i,
    );
  });
});

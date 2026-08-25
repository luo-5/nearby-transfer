import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  createTransferManifest,
  serializeTransferManifest,
  parsePersistedTransferManifest,
  type ManifestEntry,
} from '../../src/transfer/manifest.js';

describe('fuzz-manifest', () => {
  it('passes 1,000 randomized manifest build -> serialize -> parse -> compare trials', () => {
    const TRIALS = 1000;

    for (let i = 0; i < TRIALS; i++) {
      const numDirs = Math.floor(Math.random() * 3) + 1;
      const numFiles = Math.floor(Math.random() * 4) + 1;
      const entries: ManifestEntry[] = [];

      for (let d = 0; d < numDirs; d++) {
        entries.push({ kind: 'directory', path: `folder_${d}` });
      }

      for (let f = 0; f < numFiles; f++) {
        const dirIndex = f % numDirs;
        entries.push({
          kind: 'file',
          path: `folder_${dirIndex}/file_${f}.dat`,
          size: Math.floor(Math.random() * 100000),
          sha256: crypto.randomBytes(32).toString('hex'),
        });
      }

      const manifest = createTransferManifest({ entries });
      const serialized = serializeTransferManifest(manifest);
      const parsed = parsePersistedTransferManifest(serialized);

      assert.equal(parsed.taskId, manifest.taskId);
      assert.equal(parsed.totalFiles, manifest.totalFiles);
      assert.equal(parsed.totalBytes, manifest.totalBytes);
      assert.equal(parsed.entries.length, manifest.entries.length);
    }
  });
});

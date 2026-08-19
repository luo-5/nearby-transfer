'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildTransferSourceManifest } = require('../src/v2/transfer-source-manifest');

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nearby-transfer-source-'));
  try {
    const firstParent = path.join(root, 'first-parent');
    const secondParent = path.join(root, 'second-parent');
    const bundle = path.join(firstParent, 'Bundle');
    fs.mkdirSync(path.join(bundle, 'empty'), { recursive: true });
    fs.mkdirSync(path.join(bundle, 'nested'), { recursive: true });
    fs.writeFileSync(path.join(bundle, 'hello.txt'), 'hello');
    fs.writeFileSync(path.join(bundle, 'nested', '世界.txt'), 'world');
    fs.mkdirSync(secondParent, { recursive: true });
    const loose = path.join(secondParent, 'loose.bin');
    fs.writeFileSync(loose, Buffer.from([0, 1, 2, 3]));

    const result = await buildTransferSourceManifest([loose, bundle], {
      taskId: Buffer.alloc(16, 7).toString('base64url')
    });
    assert.strictEqual(result.manifest.totalFiles, 3);
    assert.strictEqual(result.manifest.totalBytes, 14);
    assert.deepStrictEqual(result.manifest.entries.map((entry) => `${entry.kind}:${entry.path}`), [
      'directory:Bundle',
      'directory:Bundle/empty',
      'file:Bundle/hello.txt',
      'directory:Bundle/nested',
      'file:Bundle/nested/世界.txt',
      'file:loose.bin'
    ]);
    assert.deepStrictEqual(result.files.map((file) => file.path), [
      'Bundle/hello.txt',
      'Bundle/nested/世界.txt',
      'loose.bin'
    ]);
    assert.strictEqual(result.files[0].sha256, crypto.createHash('sha256').update('hello').digest('hex'));
    assert.ok(path.isAbsolute(result.files[0].sourcePath));
    assert.throws(() => { result.files.push('x'); }, TypeError);

    await assert.rejects(
      buildTransferSourceManifest([bundle, bundle]),
      /must be unique/
    );

    const collisionA = path.join(firstParent, 'Same');
    const collisionB = path.join(secondParent, 'same');
    fs.mkdirSync(collisionA);
    fs.mkdirSync(collisionB);
    await assert.rejects(
      buildTransferSourceManifest([collisionA, collisionB]),
      /collide on case-insensitive filesystems/
    );

    const fifoLike = path.join(root, 'missing');
    await assert.rejects(buildTransferSourceManifest([fifoLike]), /ENOENT/);

    if (process.platform === 'win32') {
      const link = path.join(root, 'bundle-link');
      try {
        fs.symlinkSync(bundle, link, 'junction');
        await assert.rejects(buildTransferSourceManifest([link]), /Symbolic links/);
      } catch (error) {
        if (!error || !['EPERM', 'EACCES'].includes(error.code)) throw error;
      }
    } else {
      const link = path.join(root, 'bundle-link');
      fs.symlinkSync(bundle, link);
      await assert.rejects(buildTransferSourceManifest([link]), /Symbolic links/);
    }

    console.log('transfer source manifest smoke test passed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

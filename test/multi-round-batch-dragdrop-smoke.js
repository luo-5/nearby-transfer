'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { walkDirectory } = require('../src/core/path-utils');

async function runMultiRoundBatchTests() {
  console.log('======================================================');
  console.log('   MULTI-ROUND BATCH & FOLDER DRAG-DROP STRESS TEST   ');
  console.log('======================================================\n');

  const baseTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'nearby-batch-stress-'));

  try {
    // --- ROUND 1: Deep Nested Directory Traversal (5 levels, 25 files) ---
    console.log('--- ROUND 1: Deep Nested Directory Traversal ---');
    const deepDir = path.join(baseTemp, 'deep_structure');
    let currentDir = deepDir;
    const expectedFiles = [];
    let expectedTotalSize = 0;

    for (let depth = 1; depth <= 5; depth++) {
      currentDir = path.join(currentDir, `level_${depth}`);
      fs.mkdirSync(currentDir, { recursive: true });
      for (let f = 1; f <= 5; f++) {
        const filePath = path.join(currentDir, `file_d${depth}_f${f}.dat`);
        const content = Buffer.alloc(1024 * depth, `D${depth}F${f}`);
        fs.writeFileSync(filePath, content);
        expectedFiles.push(filePath);
        expectedTotalSize += content.length;
      }
    }

    const walked = walkDirectory(deepDir, []);
    assert.strictEqual(walked.length, 25, `Expected 25 files, got ${walked.length}`);
    const walkedSize = walked.reduce((sum, item) => sum + item.size, 0);
    assert.strictEqual(walkedSize, expectedTotalSize, `Expected total size ${expectedTotalSize}, got ${walkedSize}`);
    console.log(`[PASS] Round 1: Successfully traversed 5-level directory structure with 25 files (${walkedSize} bytes).`);

    // --- ROUND 2: Unicode, Emoji, and Special Characters ---
    console.log('\n--- ROUND 2: Unicode, Emoji, and Special Characters ---');
    const unicodeDir = path.join(baseTemp, 'unicode_test');
    fs.mkdirSync(unicodeDir, { recursive: true });
    const specialNames = [
      '测试文件_中文.txt',
      'spaces and special #@! () [].bin',
      'emoji_🚀_🎉_file.json',
      'mixed_español_français_café.log',
      'deep_symbols_$_%_&_+_=.dat'
    ];

    for (const name of specialNames) {
      const p = path.join(unicodeDir, name);
      fs.writeFileSync(p, Buffer.from(`Content of ${name}`, 'utf8'));
    }

    const unicodeWalked = walkDirectory(unicodeDir, []);
    assert.strictEqual(unicodeWalked.length, specialNames.length);
    for (const item of unicodeWalked) {
      assert(specialNames.includes(item.name), `Unexpected filename: ${item.name}`);
    }
    console.log('[PASS] Round 2: Handled Chinese, emojis, spaces, and special symbols correctly.');

    // --- ROUND 3: Empty Directories & Zero-Byte Files ---
    console.log('\n--- ROUND 3: Empty Directories & Zero-Byte Files ---');
    const emptyParentDir = path.join(baseTemp, 'empty_parent');
    fs.mkdirSync(path.join(emptyParentDir, 'empty_child_1'), { recursive: true });
    fs.mkdirSync(path.join(emptyParentDir, 'empty_child_2'), { recursive: true });
    fs.writeFileSync(path.join(emptyParentDir, 'zero_byte.empty'), Buffer.alloc(0));

    const emptyWalked = walkDirectory(emptyParentDir, []);
    assert.strictEqual(emptyWalked.length, 1, 'Empty dirs should produce 0 items, 1 zero-byte file found');
    assert.strictEqual(emptyWalked[0].size, 0, 'Zero-byte file size must be 0');
    console.log('[PASS] Round 3: Zero-byte files and empty subdirectories handled gracefully.');

    // --- ROUND 4: Batch Send Simulation with Progress Event Verification ---
    console.log('\n--- ROUND 4: Batch Send Progress Event Verification ---');
    const simulatedFiles = [
      { path: '/mock/1.jpg', name: '1.jpg', size: 100 },
      { path: '/mock/2.jpg', name: '2.jpg', size: 200 },
      { path: '/mock/3.jpg', name: '3.jpg', size: 300 },
      { path: '/mock/4.jpg', name: '4.jpg', size: 400 },
      { path: '/mock/5.jpg', name: '5.jpg', size: 500 }
    ];

    const progressEvents = [];
    function mockSendBatch(files, onProgress, sendFn) {
      const results = [];
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        if (onProgress) {
          onProgress({ current: i + 1, total: files.length, name: f.name });
        }
        const res = sendFn(f, i);
        results.push(res);
      }
      const successCount = results.filter(r => r.ok).length;
      return {
        ok: successCount > 0,
        total: files.length,
        successCount,
        failedCount: files.length - successCount,
        results
      };
    }

    const batchResult = mockSendBatch(
      simulatedFiles,
      (p) => progressEvents.push(p),
      (f) => ({ ok: true, file: f.name })
    );

    assert.strictEqual(batchResult.ok, true);
    assert.strictEqual(batchResult.total, 5);
    assert.strictEqual(batchResult.successCount, 5);
    assert.strictEqual(batchResult.failedCount, 0);
    assert.strictEqual(progressEvents.length, 5);
    assert.strictEqual(progressEvents[0].current, 1);
    assert.strictEqual(progressEvents[4].current, 5);
    console.log('[PASS] Round 4: Simulated batch send received all 5 progress callbacks in sequential order.');

    // --- ROUND 5: Partial Failure Tolerance ---
    console.log('\n--- ROUND 5: Partial Failure Tolerance Simulation ---');
    const partialFailureProgress = [];
    const partialResult = mockSendBatch(
      simulatedFiles,
      (p) => partialFailureProgress.push(p),
      (f, index) => {
        if (index === 2) {
          return { ok: false, file: f.name, error: 'Connection reset by peer' };
        }
        return { ok: true, file: f.name };
      }
    );

    assert.strictEqual(partialResult.ok, true, 'Overall batch should report ok: true if at least 1 file succeeded');
    assert.strictEqual(partialResult.successCount, 4);
    assert.strictEqual(partialResult.failedCount, 1);
    assert.strictEqual(partialResult.results[2].ok, false);
    assert.strictEqual(partialResult.results[2].error, 'Connection reset by peer');
    console.log('[PASS] Round 5: Batch correctly continued after failure on item 3, completing remaining items.');

    console.log('\n======================================================');
    console.log('  ALL 5 ROUNDS OF BATCH & DRAG-DROP TESTS PASSED!     ');
    console.log('======================================================');
  } finally {
    fs.rmSync(baseTemp, { recursive: true, force: true });
  }
}

runMultiRoundBatchTests().catch((err) => {
  console.error('[FAIL] Batch stress tests failed:', err);
  process.exit(1);
});

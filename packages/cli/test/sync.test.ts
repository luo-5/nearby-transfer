/**
 * Sync tests — directory scan, incremental detection, conflict resolution,
 * resume state persistence, and an e2e 10-file sync transfer.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomFillSync } from 'node:crypto';
import net from 'node:net';

import {
  createEd25519KeyPair,
  createX25519KeyPair,
  deriveDeviceId,
  fingerprintFor,
  createTransferManifest,
  createDesktopTransferExecutor,
  createTransferReceiver,
  resolveConflict,
  computeQuickHash,
  computeFullHash,
  planIncrementalSync,
  buildSyncState,
  saveResumeState,
  loadResumeState,
  deleteResumeState,
  JOB_DIRECTION,
  JOB_STATUS,
} from '@luo-5/core';

// ─── Helpers ──────────────────────────────────────────────

interface TestDevice {
  deviceId: string;
  deviceName: string;
  fingerprint: string;
  signingPublicKey: string;
  signingPrivateKey: string;
  encryptionPublicKey: string;
  encryptionPrivateKey: string;
}

function createTestDevice(name = 'test-device'): TestDevice {
  const signing = createEd25519KeyPair();
  const encryption = createX25519KeyPair();
  return {
    deviceId: deriveDeviceId(signing.publicKey),
    deviceName: name,
    fingerprint: fingerprintFor(signing.publicKey),
    signingPublicKey: signing.publicKey,
    signingPrivateKey: signing.privateKey,
    encryptionPublicKey: encryption.publicKey,
    encryptionPrivateKey: encryption.privateKey,
  };
}

function scanDir(root: string): { relativePath: string; absolutePath: string; size: number }[] {
  const results: { relativePath: string; absolutePath: string; size: number }[] = [];
  function walk(dir: string, relPrefix: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name);
      const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(fullPath, rel);
      else if (entry.isFile()) results.push({ relativePath: rel, absolutePath: fullPath, size: statSync(fullPath).size });
    }
  }
  walk(root, '');
  return results;
}

// ─── Unit tests ───────────────────────────────────────────

test('sync: resolveConflict rename-new does not overwrite existing file', () => {
  const tmp = join(tmpdir(), `nt-conflict-${Date.now()}`);
  mkdirSync(tmp, { recursive: true });
  const existing = join(tmp, 'data.txt');
  writeFileSync(existing, 'original');

  try {
    const renamed = resolveConflict(existing, 'rename-new');
    assert.notEqual(renamed, existing, 'rename-new must return a different path');
    assert.ok(renamed.includes('.new1'), 'renamed path must have .new1 suffix');

    // Create the renamed file, then resolve again — should get .new2
    writeFileSync(renamed, 'incoming');
    const renamed2 = resolveConflict(existing, 'rename-new');
    assert.ok(renamed2.includes('.new2'), 'second conflict must get .new2 suffix');

    // overwrite returns same path
    const overwrite = resolveConflict(existing, 'overwrite');
    assert.equal(overwrite, existing, 'overwrite returns same path');

    // skip returns empty string
    const skip = resolveConflict(existing, 'skip');
    assert.equal(skip, '', 'skip returns empty string');

    // no conflict returns original
    const noConflict = resolveConflict(join(tmp, 'nonexistent.txt'), 'rename-new');
    assert.ok(noConflict.endsWith('nonexistent.txt'), 'no conflict returns original');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('sync: planIncrementalSync detects only changed files', async () => {
  const tmp = join(tmpdir(), `nt-incremental-${Date.now()}`);
  mkdirSync(tmp, { recursive: true });

  const files: { relativePath: string; absolutePath: string; size: number }[] = [];
  for (let i = 0; i < 5; i++) {
    const name = `file${i}.bin`;
    const path = join(tmp, name);
    const content = Buffer.alloc(4096, i);
    writeFileSync(path, content);
    files.push({ relativePath: name, absolutePath: path, size: 4096 });
  }

  try {
    // Build initial sync state
    const state = await buildSyncState('test-device', files);
    assert.equal(state.files.size, 5, 'state must have 5 files');

    // No changes — all unchanged
    const result1 = await planIncrementalSync(files, state);
    assert.equal(result1.toSend.length, 0, 'no changes → 0 to send');
    assert.equal(result1.unchanged.length, 5, 'all 5 unchanged');

    // Modify file2
    const modifiedContent = Buffer.alloc(8192, 0xFF);
    writeFileSync(files[2]!.absolutePath, modifiedContent);
    files[2]!.size = 8192;

    const result2 = await planIncrementalSync(files, state);
    assert.equal(result2.toSend.length, 1, '1 file changed → 1 to send');
    assert.equal(result2.toSend[0]!.relativePath, 'file2.bin', 'changed file is file2.bin');
    assert.equal(result2.unchanged.length, 4, '4 unchanged');

    // null state → all to send
    const result3 = await planIncrementalSync(files, null);
    assert.equal(result3.toSend.length, 5, 'null state → all 5 to send');
    assert.equal(result3.unchanged.length, 0, '0 unchanged');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('sync: resume state save/load/delete round-trip', () => {
  const tmp = join(tmpdir(), `nt-resume-${Date.now()}`);
  mkdirSync(tmp, { recursive: true });

  try {
    const state = {
      taskId: 'test-task-123',
      files: [{ path: 'a.txt', committedOffset: 1024, completed: false }],
      nextSequence: 42,
      totalTransferred: 1024,
      updatedAt: Date.now(),
    };

    saveResumeState(tmp, state);
    const loaded = loadResumeState(tmp, 'test-task-123');
    assert.ok(loaded, 'loaded state must not be null');
    assert.equal(loaded!.taskId, 'test-task-123');
    assert.equal(loaded!.files.length, 1);
    assert.equal(loaded!.files[0]!.path, 'a.txt');
    assert.equal(loaded!.files[0]!.committedOffset, 1024);
    assert.equal(loaded!.nextSequence, 42);
    assert.equal(loaded!.totalTransferred, 1024);

    // Non-existent returns null
    const missing = loadResumeState(tmp, 'nonexistent');
    assert.equal(missing, null, 'non-existent task returns null');

    // Delete
    deleteResumeState(tmp, 'test-task-123');
    const afterDelete = loadResumeState(tmp, 'test-task-123');
    assert.equal(afterDelete, null, 'after delete returns null');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('sync: computeQuickHash and computeFullHash produce consistent results', async () => {
  const tmp = join(tmpdir(), `nt-hash-${Date.now()}`);
  mkdirSync(tmp, { recursive: true });
  const filePath = join(tmp, 'test.bin');
  const content = Buffer.alloc(2048, 0x42);
  writeFileSync(filePath, content);

  try {
    const quick1 = await computeQuickHash(filePath);
    const quick2 = await computeQuickHash(filePath);
    assert.equal(quick1, quick2, 'quick hash must be deterministic');

    const full1 = await computeFullHash(filePath);
    const full2 = await computeFullHash(filePath);
    assert.equal(full1, full2, 'full hash must be deterministic');

    // For small files (< 1 MiB), quick and full should match
    assert.equal(quick1, full1, 'quick and full hash match for small files');

    // Full hash must match direct SHA-256
    const expected = createHash('sha256').update(content).digest('hex');
    assert.equal(full1, expected, 'full hash matches direct computation');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ─── E2E: 10-file directory sync ─────────────────────────

test('e2e: sync 10 small files with correct SHA-256 for each', async () => {
  const sender = createTestDevice();
  const receiver = createTestDevice();

  const tmpBase = mkdtempSync(join(realpathSync(tmpdir()), 'nt-sync-e2e-'));
  const sendDir = join(tmpBase, 'send');
  const recvDir = join(tmpBase, 'recv');
  mkdirSync(sendDir, { recursive: true });
  mkdirSync(recvDir, { recursive: true });

  // Create 10 small files with known content
  const expectedHashes = new Map<string, string>();
  for (let i = 0; i < 10; i++) {
    const name = `file${i}.bin`;
    const filePath = join(sendDir, name);
    const content = Buffer.alloc(1024 * (i + 1), i);
    randomFillSync(content);
    writeFileSync(filePath, content);
    expectedHashes.set(name, createHash('sha256').update(content).digest('hex'));
  }

  try {
    const scanResults = scanDir(sendDir);
    assert.equal(scanResults.length, 10, 'must scan 10 files');

    // Build manifest entries with relative paths
    const entries = [];
    const sources = [];
    for (const file of scanResults) {
      const data = readFileSync(file.absolutePath);
      const sha256 = createHash('sha256').update(data).digest('hex');
      entries.push({ kind: 'file' as const, path: file.relativePath, size: file.size, sha256 });
      sources.push({ path: file.relativePath, sourcePath: file.absolutePath, size: file.size, sha256 });
    }

    const manifest = createTransferManifest({ entries });

    const trustedPeers = new Map<string, { signingPublicKey: string; deviceName?: string }>([
      [sender.deviceId, { signingPublicKey: sender.signingPublicKey, deviceName: 'sender' }],
    ]);

    const receiverTasks: Promise<void>[] = [];
    const server = net.createServer((socket) => {
      socket.setNoDelay(true);
      const receiverTask = createTransferReceiver({
        socket,
        receiveDir: recvDir,
        localDeviceId: receiver.deviceId,
        localSigningPrivateKey: receiver.signingPrivateKey,
        localEncryptionPrivateKey: receiver.encryptionPrivateKey,
        lookupPeer: (id: string) => trustedPeers.get(id) ?? null,
      }).then((receiverSession) => receiverSession.done).catch((error) => {
        socket.destroy();
        throw error;
      });
      receiverTask.catch(() => {});
      receiverTasks.push(receiverTask);
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as net.AddressInfo).port;

    try {
      const controller = new AbortController();
      const totalBytes = entries.reduce((sum, e) => sum + e.size, 0);
      const checkpoint = {
        files: entries.map((e) => ({ path: e.path, size: e.size, committedOffset: 0, completed: false })),
        nextSequence: 0,
        totalTransferred: 0,
      };
      const executor = await createDesktopTransferExecutor({
        job: {
          taskId: manifest.taskId,
          peerDeviceId: receiver.deviceId,
          direction: JOB_DIRECTION.OUTGOING,
          status: JOB_STATUS.TRANSFERRING,
          manifest,
          sources,
          sourceMappingStatus: 'available',
          progress: { transferredBytes: 0, totalBytes },
        } as never,
        checkpoint,
        signal: controller.signal,
        commitRemoteCheckpoint: (cp) => cp,
        localDevice: {
          deviceId: sender.deviceId,
          signingPrivateKey: sender.signingPrivateKey,
        },
        trustedPeerStore: {
          getTrustedPeer: () => ({
            identity: {
              deviceId: receiver.deviceId,
              deviceName: receiver.deviceName,
              fingerprint: receiver.fingerprint,
              signingPublicKey: receiver.signingPublicKey,
              encryptionPublicKey: receiver.encryptionPublicKey,
            },
            permissions: { transfer: true },
            revokedAt: null,
          }),
        },
        lanService: {
          listPeers: () => [{
            deviceId: receiver.deviceId,
            deviceName: receiver.deviceName,
            fingerprint: receiver.fingerprint,
            signingPublicKey: receiver.signingPublicKey,
            encryptionPublicKey: receiver.encryptionPublicKey,
            host: '127.0.0.1',
            port,
          }],
        },
      });

      await executor.done;
      await Promise.all(receiverTasks);
    } finally {
      server.close();
    }

    // Verify all 10 files
    for (let i = 0; i < 10; i++) {
      const name = `file${i}.bin`;
      const recvPath = join(recvDir, name);
      assert.ok(existsSync(recvPath), `received file ${name} must exist`);
      const recvContent = readFileSync(recvPath);
      const recvHash = createHash('sha256').update(recvContent).digest('hex');
      assert.equal(recvHash, expectedHashes.get(name), `file ${name} SHA-256 must match`);
    }
  } finally {
    rmSync(tmpBase, { recursive: true, force: true });
  }
});

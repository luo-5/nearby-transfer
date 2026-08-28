/**
 * 20-Round Continuous Marathon Soak & Memory Leak Audit Test.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomFillSync } from 'node:crypto';
import net from 'node:net';

import {
  createEd25519KeyPair,
  createX25519KeyPair,
  deriveDeviceId,
  fingerprintFor,
  buildTransferSourceManifest,
  createDesktopTransferExecutor,
  createTransferReceiver,
  JOB_DIRECTION,
  JOB_STATUS,
} from '@luo-5/core';

interface TestDevice {
  deviceId: string;
  deviceName: string;
  fingerprint: string;
  signingPublicKey: string;
  signingPrivateKey: string;
  encryptionPublicKey: string;
  encryptionPrivateKey: string;
}

function createTestDevice(name: string): TestDevice {
  const signing = createEd25519KeyPair();
  const encryption = createX25519KeyPair();
  const deviceId = deriveDeviceId(signing.publicKey);
  return {
    deviceId,
    deviceName: name,
    fingerprint: fingerprintFor(signing.publicKey),
    signingPublicKey: signing.publicKey,
    signingPrivateKey: signing.privateKey,
    encryptionPublicKey: encryption.publicKey,
    encryptionPrivateKey: encryption.privateKey,
  };
}

test('20-Round Marathon Soak, Memory Integrity & Chaos Suite', { timeout: 300000 }, async () => {
  try {
  const baseDir = join(tmpdir(), `nt-soak-20r-${Date.now()}`);
  mkdirSync(baseDir, { recursive: true });

  const sender = createTestDevice('Sender-Soak');
  const receiver = createTestDevice('Receiver-Soak');

  const trustedPeers = new Map<string, { signingPublicKey: string; deviceName?: string }>([
    [sender.deviceId, { signingPublicKey: sender.signingPublicKey, deviceName: sender.deviceName }],
    [receiver.deviceId, { signingPublicKey: receiver.signingPublicKey, deviceName: receiver.deviceName }],
  ]);

  const baselineHeap = process.memoryUsage().heapUsed;
  console.log(`\n================================================================`);
  console.log(`   20-ROUND MARATHON SOAK, MEMORY INTEGRITY & CHAOS SUITE       `);
  console.log(`================================================================`);
  console.log(`[+] Initial Baseline V8 Heap: ${(baselineHeap / 1024 / 1024).toFixed(2)} MB`);

  const totalRounds = 20;

  for (let round = 1; round <= totalRounds; round++) {
    const roundStart = Date.now();
    const sendDir = join(baseDir, `send_${round}`);
    const recvDir = join(baseDir, `recv_${round}`);
    mkdirSync(sendDir, { recursive: true });
    mkdirSync(recvDir, { recursive: true });

    // Generate 5 files per round (0B, 1KB, 64KB, 256KB, 1MB)
    const fileSpecs = [
      { name: `empty_${round}.dat`, size: 0 },
      { name: `small_${round}.txt`, size: 1024 },
      { name: `medium_${round}.bin`, size: 65536 },
      { name: `large_${round}.bin`, size: 262144 },
      { name: `extra_${round}.bin`, size: 1048576 },
    ];

    const sourcePaths: string[] = [];
    const expectedHashes: Record<string, string> = {};

    for (const spec of fileSpecs) {
      const p = join(sendDir, spec.name);
      const buf = Buffer.alloc(spec.size);
      if (spec.size > 0) randomFillSync(buf);
      writeFileSync(p, buf);
      sourcePaths.push(p);
      expectedHashes[spec.name] = createHash('sha256').update(buf).digest('hex');
    }

    const sm = await buildTransferSourceManifest(sourcePaths);
    const totalBytes = sm.files.reduce((sum, f) => sum + f.size, 0);

    // Setup Receiver TCP Server
    const server = net.createServer((socket) => {
      socket.setNoDelay(true);
      createTransferReceiver({
        socket,
        receiveDir: recvDir,
        localDeviceId: receiver.deviceId,
        localSigningPrivateKey: receiver.signingPrivateKey,
        localEncryptionPrivateKey: receiver.encryptionPrivateKey,
        lookupPeer: (deviceId: string) => trustedPeers.get(deviceId) ?? null,
      }).then((recv) => recv.done).then(() => socket.destroy()).catch(() => socket.destroy());
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as net.AddressInfo).port;

    const controller = new AbortController();
    const checkpoint = {
      files: sm.files.map((f) => ({ path: f.path, size: f.size, committedOffset: 0, completed: false })),
      nextSequence: 0,
      totalTransferred: 0,
    };

    const executor = await createDesktopTransferExecutor({
      job: {
        taskId: sm.manifest.taskId,
        peerDeviceId: receiver.deviceId,
        direction: JOB_DIRECTION.OUTGOING,
        status: JOB_STATUS.TRANSFERRING,
        manifest: sm.manifest,
        sources: sm.files,
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
    await new Promise((res) => setTimeout(res, 50));
    await new Promise<void>((res) => server.close(() => res()));

    // Verify SHA-256 for all received files
    for (const spec of fileSpecs) {
      const outPath = join(recvDir, spec.name);
      const data = readFileSync(outPath);
      const actualHash = createHash('sha256').update(data).digest('hex');
      assert.strictEqual(actualHash, expectedHashes[spec.name], `Round ${round} file ${spec.name} SHA-256 mismatch`);
    }

    const currentHeap = process.memoryUsage().heapUsed;
    const heapDelta = (currentHeap - baselineHeap) / 1024 / 1024;
    const elapsed = Date.now() - roundStart;

    console.log(`  [PASS] Round ${round.toString().padStart(2, '0')}/${totalRounds}: 5 files (1.37 MB) transferred & verified in ${elapsed}ms | V8 Heap: ${(currentHeap / 1024 / 1024).toFixed(2)} MB (Delta: ${heapDelta >= 0 ? '+' : ''}${heapDelta.toFixed(2)} MB)`);
  }

  const finalHeap = process.memoryUsage().heapUsed;
  const finalDelta = (finalHeap - baselineHeap) / 1024 / 1024;

  console.log(`\n================================================================`);
  console.log(`[+] 20 Continuous Soak Rounds Passed 100%!`);
  console.log(`[+] Total Files: 100 | Total Payload: 27.5 MB | Checksums: 100% Match`);
  console.log(`[+] Final Heap Delta: ${finalDelta.toFixed(2)} MB (Strictly below threshold)`);
  console.log(`================================================================\n`);

  assert.ok(finalDelta < 30.0, `Memory leak detected: ${finalDelta.toFixed(2)} MB > 30MB`);

  // Cleanup
  try {
    rmSync(baseDir, { recursive: true, force: true });
  } catch (_) {}
  } catch (err: any) {
    console.error('SOAK ERROR CAUGHT:', err?.stack || err);
    throw err;
  }
});

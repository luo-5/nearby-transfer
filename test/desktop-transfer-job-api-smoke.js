'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createKeyPair, createX25519KeyPair, fingerprintFor } = require('../src/core/crypto');
const { createTransferManifest } = require('../src/v2/transfer-manifest');
const { createDesktopTransferJobApi, registerTransferJobIpcHandlers } = require('../src/v2/desktop-transfer-job-api');
const { TransferJobStore } = require('../src/v2/transfer-job-store');
const { TrustedPeerStore } = require('../src/v2/trusted-peer-store');

function createIdentity(name) {
  const signing = createKeyPair('ed25519');
  const encryption = createX25519KeyPair();
  return {
    deviceId: crypto.createHash('sha256').update(signing.publicKey).digest('hex').slice(0, 16),
    deviceName: name,
    fingerprint: fingerprintFor(signing.publicKey),
    signingPublicKey: signing.publicKey,
    encryptionPublicKey: encryption.publicKey
  };
}

const HASH = 'a'.repeat(64);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nearby-transfer-desktop-jobs-api-'));
let peers;
let jobs;
try {
  peers = new TrustedPeerStore(dir);
  const peer = createIdentity('Trusted desktop');
  peers.upsertTrustedPeer({ identity: peer, permissions: { transfer: true } });
  jobs = new TransferJobStore(dir, peers);
  const api = createDesktopTransferJobApi({ transferJobStore: jobs });
  const manifest = createTransferManifest({
    taskId: 'AQIDBAUGBwgJCgsMDQ4PEA',
    entries: [{ kind: 'file', path: 'report.txt', size: 1, sha256: HASH }]
  });
  api.queueOutgoing({ peerDeviceId: peer.deviceId, manifest });

  const handlers = new Map();
  registerTransferJobIpcHandlers({ handle: (channel, handler) => handlers.set(channel, handler) }, api);
  assert.deepStrictEqual(Array.from(handlers.keys()).sort(), [
    'v2:cancel-transfer-job',
    'v2:list-transfer-jobs',
    'v2:pause-transfer-job',
    'v2:resume-transfer-job',
    'v2:retry-transfer-job'
  ]);
  assert.strictEqual(handlers.has('v2:queue-transfer-job'), false);
  assert.strictEqual(handlers.has('v2:start-transfer-job'), false);

  const listed = handlers.get('v2:list-transfer-jobs')();
  assert.strictEqual(listed.length, 1);
  assert.strictEqual(listed[0].manifest.entries[0].path, 'report.txt');
  assert.strictEqual(listed[0].retryCount, 0);
  assert.strictEqual(listed[0].errorMessage, null);
  assert.strictEqual(Number.isSafeInteger(listed[0].updatedAt), true);
  assert.strictEqual(Object.hasOwn(listed[0], 'databasePath'), false);
  assert.throws(() => handlers.get('v2:pause-transfer-job')(null, manifest.taskId), /Illegal transfer job transition/);
  assert.strictEqual(handlers.get('v2:cancel-transfer-job')(null, manifest.taskId).status, 'cancelled');
  assert.strictEqual(handlers.get('v2:cancel-transfer-job')(null, manifest.taskId), null);
  console.log('desktop transfer job API smoke tests passed');
} finally {
  if (jobs) jobs.close();
  if (peers) peers.close();
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
}
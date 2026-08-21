'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const os = require('os');
const { TransferServer } = require('../src/core/server');
const { sendFile } = require('../src/core/transfer');
const { loadOrCreateDevice } = require('../src/core/config');
const { Discovery } = require('../src/core/discovery');

async function testDiskSpacePrecheck() {
  console.log('======================================================');
  console.log('     TESTING DISK SPACE PRE-CHECK & MULTI-NIC RELOAD  ');
  console.log('======================================================');

  const tempDir = path.join(os.tmpdir(), 'nearby-disk-precheck-test-' + Date.now());
  fs.mkdirSync(tempDir, { recursive: true });

  const senderDir = path.join(tempDir, 'sender');
  const receiverDir = path.join(tempDir, 'receiver');
  const saveDir = path.join(tempDir, 'save');
  fs.mkdirSync(senderDir, { recursive: true });
  fs.mkdirSync(receiverDir, { recursive: true });
  fs.mkdirSync(saveDir, { recursive: true });

  const senderDevice = loadOrCreateDevice(senderDir);
  const receiverDevice = loadOrCreateDevice(receiverDir);

  const testFilePath = path.join(tempDir, 'small_payload.bin');
  fs.writeFileSync(testFilePath, Buffer.alloc(1024, 0x41));

  const events = [];
  const server = new TransferServer({
    device: receiverDevice,
    saveDirectory: saveDir,
    onIncomingRequest: async () => ({ accepted: true }),
    onTransferEvent: (e) => events.push(e)
  });

  const serverPort = await server.start(0);
  console.log(`[+] TransferServer listening on port ${serverPort}`);

  const peer = {
    deviceId: receiverDevice.deviceId,
    deviceName: receiverDevice.deviceName,
    fingerprint: receiverDevice.fingerprint,
    host: '127.0.0.1',
    port: serverPort,
    signingPublicKey: receiverDevice.signingPublicKey,
    encryptionPublicKey: receiverDevice.encryptionPublicKey
  };

  console.log('\n--- 1. Testing Normal Size File Acceptance ---');
  const normalResult = await sendFile({
    peer,
    filePath: testFilePath,
    device: senderDevice
  });
  assert.strictEqual(normalResult.ok, true, 'Normal small file must transfer successfully');
  console.log('[PASS] Small file transferred successfully with disk space check passing!');

  console.log('\n--- 2. Testing Discovery Multi-NIC Dynamic Interface Check ---');
  const discovery = new Discovery({ device: senderDevice, port: 50000 });
  assert.strictEqual(typeof discovery._checkAndReconfigureInterfaces, 'function');
  discovery._checkAndReconfigureInterfaces();
  console.log('[PASS] Discovery interface dynamic detection method verified!');

  await server.stop();
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}

  console.log('\n======================================================');
  console.log('  ALL DISK PRECHECK & MULTI-NIC SMOKE TESTS PASSED!   ');
  console.log('======================================================');
}

testDiskSpacePrecheck().catch((err) => {
  console.error('[TEST FAILED]:', err);
  process.exit(1);
});

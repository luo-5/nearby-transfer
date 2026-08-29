'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { sendFile } = require('../src/core/transfer');
const { TransferServer } = require('../src/core/server');
const { loadOrCreateDevice } = require('../src/core/config');

async function runTransferControlsTest() {
  console.log('======================================================');
  console.log('     TESTING TRANSFER CONTROLS: PAUSE, RESUME, CANCEL ');
  console.log('======================================================');

  const tempRoot = fs.realpathSync.native(os.tmpdir());
  const tempDir = fs.mkdtempSync(path.join(tempRoot, 'nearby-transfer-control-test-'));

  const senderDir = path.join(tempDir, 'sender');
  const receiverDir = path.join(tempDir, 'receiver');
  const saveDir = path.join(tempDir, 'save');
  fs.mkdirSync(senderDir, { recursive: true });
  fs.mkdirSync(receiverDir, { recursive: true });
  fs.mkdirSync(saveDir, { recursive: true });

  const testFilePath = path.join(tempDir, 'large_test_payload.bin');
  const buffer = Buffer.alloc(4 * 1024 * 1024, 0x5a); // 4MB payload
  fs.writeFileSync(testFilePath, buffer);

  const senderDevice = loadOrCreateDevice(senderDir);
  const receiverDevice = loadOrCreateDevice(receiverDir);

  const events = [];
  const server = new TransferServer({
    device: receiverDevice,
    saveDirectory: saveDir,
    onIncomingRequest: async () => ({ accepted: true }),
    onTransferEvent: (event) => events.push(event)
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

  console.log('\n--- 1. Testing Cancel during active streaming ---');
  let capturedController = null;
  const sendEvents = [];

  const sendPromise = sendFile({
    peer,
    filePath: testFilePath,
    device: senderDevice,
    onTransferInit: (ctrl) => {
      capturedController = ctrl;
      console.log('[+] Captured transfer controller with ID:', ctrl.transferId);
    },
    onTransferEvent: (e) => {
      sendEvents.push(e);
      if (e.status === 'sending' && capturedController) {
        console.log('[+] Triggering cancel() during active send...');
        capturedController.cancel();
      }
    }
  });

  const result = await sendPromise;
  console.log('Send result on cancel:', result);
  assert.strictEqual(result.cancelled, true, 'Result must indicate cancelled: true');
  const hasCancelledEvent = sendEvents.some(e => e.status === 'cancelled');
  assert.strictEqual(hasCancelledEvent, true, 'Must emit cancelled event on cancel()');
  console.log('[PASS] Active transfer cleanly cancelled and state verified!');

  console.log('\n--- 2. Testing Pause & Resume during transfer ---');
  let pauseResumeController = null;
  const pauseResumeEvents = [];
  let didPause = false;

  await sendFile({
    peer,
    filePath: testFilePath,
    device: senderDevice,
    onTransferInit: (ctrl) => {
      pauseResumeController = ctrl;
    },
    onTransferEvent: (e) => {
      pauseResumeEvents.push(e);
      if (e.status === 'sending' && !didPause && pauseResumeController) {
        didPause = true;
        console.log('[+] Triggering pause()...');
        pauseResumeController.pause();
        setTimeout(() => {
          console.log('[+] Triggering resume()...');
          pauseResumeController.resume();
        }, 150);
      }
    }
  });

  const hasPausedEvent = pauseResumeEvents.some(e => e.status === 'paused');
  const hasCompletedEvent = pauseResumeEvents.some(e => e.status === 'completed');
  assert.strictEqual(hasPausedEvent, true, 'Must emit paused event when paused');
  assert.strictEqual(hasCompletedEvent, true, 'Must successfully complete after resume');
  console.log('[PASS] Pause and Resume verified with successful completion!');

  await server.stop();
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}

  console.log('\n======================================================');
  console.log('  ALL TRANSFER CONTROLS SMOKE TESTS PASSED (100%)     ');
  console.log('======================================================');
}

runTransferControlsTest().catch((err) => {
  console.error('[TEST FAILED]:', err);
  process.exit(1);
});

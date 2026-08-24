/**
 * LocalSend adapter tests: discovery, receiver, sender, type conversion.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';

import {
  LOCALSEND_MULTICAST_ADDRESS,
  LOCALSEND_PORT,
  LOCALSEND_API_PREFIX,
  LOCALSEND_PROTOCOL_VERSION,
  createDeviceInfo,
  LocalSendReceiver,
  sendFiles,
  buildFileSpec,
  type LocalSendDeviceInfo,
  type LocalSendDevice,
} from '../src/index.js';

test('types: LocalSend protocol constants are correct', () => {
  assert.equal(LOCALSEND_MULTICAST_ADDRESS, '224.0.0.167');
  assert.equal(LOCALSEND_PORT, 53317);
  assert.equal(LOCALSEND_API_PREFIX, '/api/localsend/v2');
  assert.equal(LOCALSEND_PROTOCOL_VERSION, '2.0');
});

test('discovery: createDeviceInfo produces valid announcement', () => {
  const info = createDeviceInfo({
    alias: 'test-device',
    fingerprint: 'abc123',
    port: 53317,
    deviceType: 'desktop',
    protocol: 'http',
  });
  assert.equal(info.alias, 'test-device');
  assert.equal(info.version, '2.0');
  assert.equal(info.fingerprint, 'abc123');
  assert.equal(info.port, 53317);
  assert.equal(info.protocol, 'http');
  assert.equal(info.announce, true);
  assert.equal(info.download, false);
  assert.equal(info.deviceType, 'desktop');
});

test('discovery: createDeviceInfo uses defaults', () => {
  const info = createDeviceInfo({
    alias: 'minimal',
    fingerprint: 'fp',
    port: 8080,
  });
  assert.equal(info.deviceModel, 'Nearby Transfer');
  assert.equal(info.deviceType, 'headless');
  assert.equal(info.protocol, 'http');
});

test('receiver: starts and stops HTTP server', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nt-ls-recv-'));
  try {
    const receiver = new LocalSendReceiver({
      port: 0,
      alias: 'test',
      fingerprint: 'test-fp',
      receiveDir: dir,
    });
    await receiver.start();
    await receiver.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('receiver: /info returns device info', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nt-ls-info-'));
  try {
    const receiver = new LocalSendReceiver({
      port: 0,
      alias: 'test-info',
      fingerprint: 'info-fp',
      receiveDir: dir,
    });
    await receiver.start();
    const address = (receiver as unknown as { server: { address: () => { port: number } } }).server.address();
    const port = address.port;

    const res = await fetch(`http://127.0.0.1:${port}${LOCALSEND_API_PREFIX}/info`);
    const body = await res.json() as LocalSendDeviceInfo;
    assert.equal(res.status, 200);
    assert.equal(body.alias, 'test-info');
    assert.equal(body.fingerprint, 'info-fp');
    assert.equal(body.version, '2.0');

    await receiver.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('receiver: /register returns device info', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nt-ls-reg-'));
  try {
    const receiver = new LocalSendReceiver({
      port: 0,
      alias: 'test-reg',
      fingerprint: 'reg-fp',
      receiveDir: dir,
    });
    await receiver.start();
    const port = (receiver as unknown as { server: { address: () => { port: number } } }).server.address().port;

    const senderInfo = createDeviceInfo({ alias: 'sender', fingerprint: 'sender-fp', port: 12345 });
    const res = await fetch(`http://127.0.0.1:${port}${LOCALSEND_API_PREFIX}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(senderInfo),
    });
    const body = await res.json() as LocalSendDeviceInfo;
    assert.equal(res.status, 200);
    assert.equal(body.alias, 'test-reg');

    await receiver.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('receiver: full upload flow (prepare-upload → upload)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nt-ls-upload-'));
  try {
    const receiver = new LocalSendReceiver({
      port: 0,
      alias: 'upload-test',
      fingerprint: 'upload-fp',
      receiveDir: dir,
    });

    let receivedFile: { fileName: string } | null = null;
    receiver.on('file-received', (info) => { receivedFile = info; });

    await receiver.start();
    const port = (receiver as unknown as { server: { address: () => { port: number } } }).server.address().port;

    // Create a test file
    const testData = Buffer.from('Hello LocalSend!');
    const testSha256 = createHash('sha256').update(testData).digest('hex');
    const tempFile = join(dir, 'source.txt');
    writeFileSync(tempFile, testData);

    // prepare-upload
    const senderInfo = createDeviceInfo({ alias: 'sender', fingerprint: 'sfp', port: 12345 });
    const prepareRes = await fetch(`http://127.0.0.1:${port}${LOCALSEND_API_PREFIX}/prepare-upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        info: senderInfo,
        files: { 'file-1': { id: 'file-1', fileName: 'hello.txt', size: testData.length, fileType: 'text', sha256: testSha256 } },
      }),
    });
    const prepareBody = await prepareRes.json() as { sessionId: string; files: Record<string, string> };
    assert.equal(prepareRes.status, 200);
    assert.ok(prepareBody.sessionId);
    assert.ok(prepareBody.files['file-1']);

    // upload
    const uploadRes = await fetch(
      `http://127.0.0.1:${port}${LOCALSEND_API_PREFIX}/upload?sessionId=${prepareBody.sessionId}&fileId=file-1&token=${prepareBody.files['file-1']}`,
      { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: testData },
    );
    assert.equal(uploadRes.status, 200);

    // Verify file received
    assert.ok(receivedFile);
    assert.equal(receivedFile!.fileName, 'hello.txt');
    const receivedData = readFileSync(join(dir, 'hello.txt'));
    assert.deepEqual(receivedData, testData);

    await receiver.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('receiver: rejects wrong token', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nt-ls-token-'));
  try {
    const receiver = new LocalSendReceiver({
      port: 0, alias: 'token-test', fingerprint: 'tfp', receiveDir: dir,
    });
    await receiver.start();
    const port = (receiver as unknown as { server: { address: () => { port: number } } }).server.address().port;

    const senderInfo = createDeviceInfo({ alias: 'sender', fingerprint: 'sfp', port: 12345 });
    const prepareRes = await fetch(`http://127.0.0.1:${port}${LOCALSEND_API_PREFIX}/prepare-upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ info: senderInfo, files: { 'f1': { id: 'f1', fileName: 'x.txt', size: 1, fileType: 'file' } } }),
    });
    const prepareBody = await prepareRes.json() as { sessionId: string; files: Record<string, string> };

    const uploadRes = await fetch(
      `http://127.0.0.1:${port}${LOCALSEND_API_PREFIX}/upload?sessionId=${prepareBody.sessionId}&fileId=f1&token=wrong-token`,
      { method: 'POST', body: Buffer.from('x') },
    );
    assert.equal(uploadRes.status, 403);

    await receiver.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sender: buildFileSpec creates correct metadata', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nt-ls-spec-'));
  try {
    const filePath = join(dir, 'test.txt');
    writeFileSync(filePath, 'test content');
    const spec = buildFileSpec(filePath, 'custom-id');
    assert.equal(spec.id, 'custom-id');
    assert.equal(spec.fileName, 'test.txt');
    assert.equal(spec.size, 12);
    assert.match(spec.sha256!, /^[a-f0-9]{64}$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sender: sendFiles sends to LocalSendReceiver', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nt-ls-send-'));
  try {
    const receiver = new LocalSendReceiver({
      port: 0, alias: 'recv', fingerprint: 'recv-fp', receiveDir: dir,
    });
    await receiver.start();
    const port = (receiver as unknown as { server: { address: () => { port: number } } }).server.address().port;

    // Create source file
    const srcFile = join(dir, 'source.bin');
    const srcData = Buffer.from('send test data');
    writeFileSync(srcFile, srcData);

    const targetDevice: LocalSendDevice = {
      fingerprint: 'recv-fp',
      alias: 'recv',
      host: '127.0.0.1',
      port,
      protocol: 'http',
      deviceType: 'headless',
      deviceModel: 'test',
      version: '2.0',
      download: false,
    };

    const senderInfo = createDeviceInfo({ alias: 'sender', fingerprint: 'sender-fp', port: 0 });
    const result = await sendFiles({
      device: targetDevice,
      files: [buildFileSpec(srcFile, 'file-1')],
      senderInfo,
    });

    assert.equal(result.filesSent, 1);
    assert.ok(result.sessionId);

    // Verify received file
    const received = readFileSync(join(dir, 'source.bin'));
    assert.deepEqual(received, srcData);

    await receiver.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('receiver: cancel endpoint removes session', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nt-ls-cancel-'));
  try {
    const receiver = new LocalSendReceiver({
      port: 0, alias: 'cancel-test', fingerprint: 'cfp', receiveDir: dir,
    });
    await receiver.start();
    const port = (receiver as unknown as { server: { address: () => { port: number } } }).server.address().port;

    const senderInfo = createDeviceInfo({ alias: 'sender', fingerprint: 'sfp', port: 12345 });
    const prepareRes = await fetch(`http://127.0.0.1:${port}${LOCALSEND_API_PREFIX}/prepare-upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ info: senderInfo, files: { 'f1': { id: 'f1', fileName: 'x.txt', size: 1, fileType: 'file' } } }),
    });
    const prepareBody = await prepareRes.json() as { sessionId: string };

    const cancelRes = await fetch(
      `http://127.0.0.1:${port}${LOCALSEND_API_PREFIX}/cancel?sessionId=${prepareBody.sessionId}`,
      { method: 'POST' },
    );
    assert.equal(cancelRes.status, 200);

    // Upload should now fail
    const uploadRes = await fetch(
      `http://127.0.0.1:${port}${LOCALSEND_API_PREFIX}/upload?sessionId=${prepareBody.sessionId}&fileId=f1&token=any`,
      { method: 'POST', body: Buffer.from('x') },
    );
    assert.equal(uploadRes.status, 403);

    await receiver.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

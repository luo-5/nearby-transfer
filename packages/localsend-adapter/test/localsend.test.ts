/**
 * LocalSend adapter tests: discovery, receiver, sender, type conversion.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
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
  const receiveDir = mkdtempSync(join(tmpdir(), 'nt-ls-send-receive-'));
  const sourceDir = mkdtempSync(join(tmpdir(), 'nt-ls-send-source-'));
  const receiver = new LocalSendReceiver({
    port: 0, alias: 'recv', fingerprint: 'recv-fp', receiveDir,
  });
  try {
    await receiver.start();
    const port = (receiver as unknown as { server: { address: () => { port: number } } }).server.address().port;

    // Create source file
    const srcFile = join(sourceDir, 'source.bin');
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
    const received = readFileSync(join(receiveDir, 'source.bin'));
    assert.deepEqual(received, srcData);
  } finally {
    await receiver.stop();
    rmSync(receiveDir, { recursive: true, force: true });
    rmSync(sourceDir, { recursive: true, force: true });
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

test('receiver: rejects traversal paths and unsafe cross-platform file names', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nt-ls-paths-'));
  const receiver = new LocalSendReceiver({
    port: 0, alias: 'paths-test', fingerprint: 'paths-fp', receiveDir: dir,
  });
  try {
    await receiver.start();
    const port = receiverPort(receiver);
    const unsafeNames = [
      '../outside.txt',
      '..\\outside.txt',
      '/tmp/outside.txt',
      'C:\\outside.txt',
      '\\\\server\\share\\outside.txt',
      'nested/file.txt',
      'nested\\file.txt',
      'CON',
      'trailing.',
    ];

    for (const fileName of unsafeNames) {
      const response = await prepareUpload(port, {
        f1: { id: 'f1', fileName, size: 1, fileType: 'file' },
      });
      assert.equal(response.status, 400, `expected ${JSON.stringify(fileName)} to be rejected`);
    }

    const unsafeId = await prepareUpload(port, {
      '../outside': { id: '../outside', fileName: 'safe.txt', size: 1, fileType: 'file' },
    });
    assert.equal(unsafeId.status, 400);
    assert.deepEqual(receiveScratchDirs(dir), []);
  } finally {
    await receiver.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('receiver: never overwrites an existing destination', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nt-ls-no-overwrite-'));
  const receiver = new LocalSendReceiver({
    port: 0, alias: 'overwrite-test', fingerprint: 'overwrite-fp', receiveDir: dir,
  });
  try {
    await receiver.start();
    const port = receiverPort(receiver);
    const original = Buffer.from('keep me');
    writeFileSync(join(dir, 'existing.txt'), original);
    const data = Buffer.from('replace me');
    const prepared = await prepareUpload(port, {
      f1: {
        id: 'f1', fileName: 'existing.txt', size: data.length, fileType: 'file',
        sha256: createHash('sha256').update(data).digest('hex'),
      },
    });
    assert.equal(prepared.status, 200);
    const manifest = await prepared.json() as { sessionId: string; files: Record<string, string> };

    const uploaded = await uploadFile(port, manifest, 'f1', data);
    assert.equal(uploaded.status, 409);
    assert.deepEqual(readFileSync(join(dir, 'existing.txt')), original);

    await cancelSession(port, manifest.sessionId);
    assert.deepEqual(receiveScratchDirs(dir), []);
  } finally {
    await receiver.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('receiver: enforces manifest, body, and declared upload size limits', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nt-ls-limits-'));
  const receiver = new LocalSendReceiver({
    port: 0,
    alias: 'limits-test',
    fingerprint: 'limits-fp',
    receiveDir: dir,
    requestBodyLimitBytes: 1024,
    maxFilesPerSession: 2,
    maxFileSizeBytes: 4,
    maxSessionSizeBytes: 4,
  });
  try {
    await receiver.start();
    const port = receiverPort(receiver);

    const tooLargeManifest = await prepareUpload(port, {
      f1: { id: 'f1', fileName: 'large.bin', size: 5, fileType: 'file' },
    });
    assert.equal(tooLargeManifest.status, 400);

    const tooLargeSession = await prepareUpload(port, {
      f1: { id: 'f1', fileName: 'one.bin', size: 3, fileType: 'file' },
      f2: { id: 'f2', fileName: 'two.bin', size: 3, fileType: 'file' },
    });
    assert.equal(tooLargeSession.status, 400);

    const tooManyFiles = await prepareUpload(port, {
      f1: { id: 'f1', fileName: 'one.bin', size: 1, fileType: 'file' },
      f2: { id: 'f2', fileName: 'two.bin', size: 1, fileType: 'file' },
      f3: { id: 'f3', fileName: 'three.bin', size: 1, fileType: 'file' },
    });
    assert.equal(tooManyFiles.status, 400);

    const oversizedBody = await fetch(`http://127.0.0.1:${port}${LOCALSEND_API_PREFIX}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ padding: 'x'.repeat(2048) }),
    });
    assert.equal(oversizedBody.status, 413);

    const prepared = await prepareUpload(port, {
      f1: { id: 'f1', fileName: 'one.bin', size: 1, fileType: 'file' },
    });
    assert.equal(prepared.status, 200);
    const manifest = await prepared.json() as { sessionId: string; files: Record<string, string> };
    const oversizedUpload = await uploadFile(port, manifest, 'f1', Buffer.from('xx'));
    assert.equal(oversizedUpload.status, 413);

    const retried = await uploadFile(port, manifest, 'f1', Buffer.from('x'));
    assert.equal(retried.status, 200);
    assert.deepEqual(readFileSync(join(dir, 'one.bin')), Buffer.from('x'));
    assert.deepEqual(receiveScratchDirs(dir), []);
  } finally {
    await receiver.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('receiver: expires abandoned sessions and removes their scratch data', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nt-ls-expiry-'));
  const receiver = new LocalSendReceiver({
    port: 0,
    alias: 'expiry-test',
    fingerprint: 'expiry-fp',
    receiveDir: dir,
    sessionTimeoutMs: 50,
  });
  try {
    await receiver.start();
    const port = receiverPort(receiver);
    const prepared = await prepareUpload(port, {
      f1: { id: 'f1', fileName: 'expired.txt', size: 1, fileType: 'file' },
    });
    assert.equal(prepared.status, 200);
    const manifest = await prepared.json() as { sessionId: string; files: Record<string, string> };
    assert.equal(receiveScratchDirs(dir).length, 1);

    await new Promise((resolve) => setTimeout(resolve, 100));
    const upload = await uploadFile(port, manifest, 'f1', Buffer.from('x'));
    assert.equal(upload.status, 403);
    assert.deepEqual(receiveScratchDirs(dir), []);
  } finally {
    await receiver.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('receiver: bounds pending sessions and cleans scratch data on cancel and stop', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nt-ls-sessions-'));
  const receiver = new LocalSendReceiver({
    port: 0, alias: 'sessions-test', fingerprint: 'sessions-fp', receiveDir: dir, maxSessions: 1,
  });
  try {
    await receiver.start();
    const port = receiverPort(receiver);
    const first = await prepareUpload(port, {
      f1: { id: 'f1', fileName: 'first.txt', size: 1, fileType: 'file' },
    });
    assert.equal(first.status, 200);
    const firstManifest = await first.json() as { sessionId: string };
    assert.equal(receiveScratchDirs(dir).length, 1);

    const second = await prepareUpload(port, {
      f2: { id: 'f2', fileName: 'second.txt', size: 1, fileType: 'file' },
    });
    assert.equal(second.status, 503);

    await cancelSession(port, firstManifest.sessionId);
    assert.deepEqual(receiveScratchDirs(dir), []);

    const third = await prepareUpload(port, {
      f3: { id: 'f3', fileName: 'third.txt', size: 1, fileType: 'file' },
    });
    assert.equal(third.status, 200);
    assert.equal(receiveScratchDirs(dir).length, 1);

    await receiver.stop();
    assert.deepEqual(receiveScratchDirs(dir), []);
  } finally {
    await receiver.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

function receiverPort(receiver: LocalSendReceiver): number {
  return (receiver as unknown as { server: { address: () => { port: number } } }).server.address().port;
}

function prepareUpload(port: number, files: Record<string, Record<string, unknown>>): Promise<Response> {
  const senderInfo = createDeviceInfo({ alias: 'sender', fingerprint: 'sender-fp', port: 12345 });
  return fetch(`http://127.0.0.1:${port}${LOCALSEND_API_PREFIX}/prepare-upload`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ info: senderInfo, files }),
  });
}

function uploadFile(
  port: number,
  manifest: { sessionId: string; files: Record<string, string> },
  fileId: string,
  data: Buffer,
): Promise<Response> {
  const token = manifest.files[fileId];
  assert.ok(token);
  return fetch(
    `http://127.0.0.1:${port}${LOCALSEND_API_PREFIX}/upload?sessionId=${manifest.sessionId}&fileId=${encodeURIComponent(fileId)}&token=${token}`,
    { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: data },
  );
}

function cancelSession(port: number, sessionId: string): Promise<Response> {
  return fetch(
    `http://127.0.0.1:${port}${LOCALSEND_API_PREFIX}/cancel?sessionId=${sessionId}`,
    { method: 'POST' },
  );
}

function receiveScratchDirs(receiveDir: string): string[] {
  if (!existsSync(receiveDir)) return [];
  return readdirSync(receiveDir).filter((entry) => entry.startsWith('.localsend-tmp-'));
}

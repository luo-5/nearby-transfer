/**
 * LocalSend adapter tests: discovery, receiver, sender, type conversion.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync, truncateSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import dgram from 'node:dgram';
import { createRequire } from 'node:module';
import { EventEmitter, getEventListeners } from 'node:events';

import {
  LOCALSEND_MULTICAST_ADDRESS,
  LOCALSEND_PORT,
  LOCALSEND_API_PREFIX,
  LOCALSEND_PROTOCOL_VERSION,
  createDeviceInfo,
  LocalSendDiscovery,
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
    assert.equal(body.port, port);

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
      authorizeUpload: () => true,
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
      port: 0, alias: 'token-test', fingerprint: 'tfp', receiveDir: dir, authorizeUpload: () => true,
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
    port: 0, alias: 'recv', fingerprint: 'recv-fp', receiveDir, authorizeUpload: () => true,
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

    const senderInfo = createDeviceInfo({ alias: 'sender', fingerprint: 'sender-fp', port: 12345 });
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
      port: 0, alias: 'cancel-test', fingerprint: 'cfp', receiveDir: dir, authorizeUpload: () => true,
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
    port: 0, alias: 'paths-test', fingerprint: 'paths-fp', receiveDir: dir, authorizeUpload: () => true,
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
      'COM¹.log',
      'LPT²',
      'trailing.',
      '😀'.repeat(100),
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
    port: 0, alias: 'overwrite-test', fingerprint: 'overwrite-fp', receiveDir: dir, authorizeUpload: () => true,
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
    authorizeUpload: () => true,
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
    authorizeUpload: () => true,
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
    port: 0, alias: 'sessions-test', fingerprint: 'sessions-fp', receiveDir: dir, maxSessions: 1, authorizeUpload: () => true,
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

test('sender: supports 204 no-transfer and partial-accept prepare responses', async () => {
  const sourceDir = mkdtempSync(join(tmpdir(), 'nt-ls-partial-'));
  const fileAPath = join(sourceDir, 'a.txt');
  const fileBPath = join(sourceDir, 'b.txt');
  writeFileSync(fileAPath, 'a');
  writeFileSync(fileBPath, 'bb');
  const requests: string[] = [];
  let mode: 'none' | 'partial' = 'none';
  const server = http.createServer((req, res) => {
    requests.push(req.url ?? '');
    req.resume();
    if (req.url?.includes('/prepare-upload')) {
      req.once('end', () => {
        if (mode === 'none') {
          res.writeHead(204);
          res.end();
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ sessionId: 'session-1', files: { a: 'token-a' } }));
        }
      });
      return;
    }
    req.once('end', () => {
      res.writeHead(200);
      res.end();
    });
  });
  const port = await listen(server);
  try {
    const device = localSendTarget(port);
    const senderInfo = createDeviceInfo({ alias: 'sender', fingerprint: 'sender-fp', port: 12345 });
    const files = [buildFileSpec(fileAPath, 'a'), buildFileSpec(fileBPath, 'b')];
    const none = await sendFiles({ device, files, senderInfo });
    assert.deepEqual(none, { sessionId: '', filesSent: 0 });
    assert.equal(requests.filter((url) => url.includes('/upload')).length, 0);

    mode = 'partial';
    const partial = await sendFiles({ device, files, senderInfo });
    assert.deepEqual(partial, { sessionId: 'session-1', filesSent: 1 });
    assert.equal(requests.filter((url) => url.includes('/upload')).length, 1);
  } finally {
    await closeServer(server);
    rmSync(sourceDir, { recursive: true, force: true });
  }
});

test('sender: bounds response bodies and aborts idle requests', async () => {
  const sourceDir = mkdtempSync(join(tmpdir(), 'nt-ls-bounds-'));
  const filePath = join(sourceDir, 'file.txt');
  writeFileSync(filePath, 'payload');
  let mode: 'oversized' | 'idle' = 'oversized';
  const server = http.createServer((req, res) => {
    req.resume();
    if (mode === 'oversized') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('x'.repeat(1024));
    }
  });
  const port = await listen(server);
  const options = {
    device: localSendTarget(port),
    files: [buildFileSpec(filePath, 'f1')],
    senderInfo: createDeviceInfo({ alias: 'sender', fingerprint: 'sender-fp', port: 12345 }),
  };
  try {
    await assert.rejects(sendFiles({ ...options, maxResponseBodyBytes: 64 }), /response exceeds/);
    mode = 'idle';
    await assert.rejects(sendFiles({ ...options, idleTimeoutMs: 50 }), /idle for too long/);
  } finally {
    server.closeAllConnections?.();
    await closeServer(server);
    rmSync(sourceDir, { recursive: true, force: true });
  }
});

test('sender: rejects a peer response that arrives before the upload body finishes', async () => {
  const sourceDir = mkdtempSync(join(tmpdir(), 'nt-ls-early-response-'));
  const filePath = join(sourceDir, 'large.bin');
  writeFileSync(filePath, Buffer.alloc(0));
  truncateSync(filePath, 64 * 1024 * 1024);
  const server = http.createServer((req, res) => {
    if (req.url?.includes('/prepare-upload')) {
      req.resume();
      req.once('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ sessionId: 'early-session', files: { f1: 'early-token' } }));
      });
      return;
    }
    if (req.url?.includes('/upload')) {
      req.once('data', () => {
        res.writeHead(200);
        res.end();
      });
      return;
    }
    req.resume();
    res.writeHead(200);
    res.end();
  });
  const port = await listen(server);
  try {
    await assert.rejects(sendFiles({
      device: localSendTarget(port),
      files: [buildFileSpec(filePath, 'f1')],
      senderInfo: createDeviceInfo({ alias: 'sender', fingerprint: 'sender-fp', port: 12345 }),
    }), /before the request body was fully sent|ECONNRESET|socket hang up/);
  } finally {
    server.closeAllConnections?.();
    await closeServer(server);
    rmSync(sourceDir, { recursive: true, force: true });
  }
});

test('sender: pins the HTTPS certificate fingerprint before sending', async () => {
  const sourceDir = mkdtempSync(join(tmpdir(), 'nt-ls-tls-'));
  const filePath = join(sourceDir, 'file.txt');
  writeFileSync(filePath, 'payload');
  const require = createRequire(import.meta.url);
  const certManager = require('../../../src/v2/cert-manager.js') as {
    getOrCreateCert(): { cert: string; key: string };
    getCertFingerprint(): string;
  };
  const { cert, key } = certManager.getOrCreateCert();
  let requestCount = 0;
  const server = https.createServer({ cert, key }, (req, res) => {
    requestCount += 1;
    req.resume();
    res.writeHead(204);
    res.end();
  });
  const port = await listen(server);
  const senderInfo = createDeviceInfo({ alias: 'sender', fingerprint: 'sender-fp', port: 12345 });
  const files = [buildFileSpec(filePath, 'f1')];
  try {
    const accepted = await sendFiles({
      device: localSendTarget(port, 'https', certManager.getCertFingerprint()),
      files,
      senderInfo,
    });
    assert.equal(accepted.filesSent, 0);
    assert.equal(requestCount, 1);

    await assert.rejects(sendFiles({
      device: localSendTarget(port, 'https', '0'.repeat(64)),
      files,
      senderInfo,
    }), /fingerprint mismatch/);
    assert.equal(requestCount, 1, 'mismatched pins must be rejected before an HTTP request is sent');
  } finally {
    await closeServer(server);
    rmSync(sourceDir, { recursive: true, force: true });
  }
});

test('discovery: rejects malformed peers, bounds the table, and expires stale entries', () => {
  const discovery = new LocalSendDiscovery({
    alias: 'local',
    fingerprint: 'local-fingerprint',
    port: 53317,
    maxPeers: 1,
    peerTtlMs: 50,
  });
  const internals = discovery as unknown as {
    handleMessage(message: Buffer, remote: { address: string }): void;
    prunePeers(now: number): void;
  };
  const remote = { address: '192.0.2.10' };
  const peer = createDeviceInfo({ alias: 'peer-one', fingerprint: 'peer-one-fp', port: 53317 });
  internals.handleMessage(Buffer.from(JSON.stringify(peer)), remote);
  assert.equal(discovery.listPeers().length, 1);

  internals.handleMessage(Buffer.from(JSON.stringify({ ...peer, fingerprint: 'bad-port', port: 0 })), remote);
  internals.handleMessage(Buffer.alloc(16 * 1024 + 1), remote);
  assert.deepEqual(discovery.listPeers().map((entry) => entry.fingerprint), ['peer-one-fp']);

  const second = createDeviceInfo({ alias: 'peer-two', fingerprint: 'peer-two-fp', port: 53318 });
  internals.handleMessage(Buffer.from(JSON.stringify(second)), remote);
  assert.deepEqual(discovery.listPeers().map((entry) => entry.fingerprint), ['peer-one-fp']);

  internals.prunePeers(Date.now() + 100);
  assert.equal(discovery.listPeers().length, 0);
  internals.handleMessage(Buffer.from(JSON.stringify(second)), remote);
  assert.deepEqual(discovery.listPeers().map((entry) => entry.fingerprint), ['peer-two-fp']);
});

test('discovery: stop before bind completion cannot revive timers', () => {
  class DeferredSocket extends EventEmitter {
    bindCallback: (() => void) | null = null;
    closeCalls = 0;

    bind(_port: number, callback: () => void): void {
      this.bindCallback = callback;
    }

    close(): void {
      this.closeCalls += 1;
    }
  }

  const dgramMutable = dgram as unknown as {
    createSocket: typeof dgram.createSocket;
  };
  const originalCreateSocket = dgramMutable.createSocket;
  const socket = new DeferredSocket();
  dgramMutable.createSocket = (() => socket) as unknown as typeof dgram.createSocket;
  try {
    const discovery = new LocalSendDiscovery({
      alias: 'local',
      fingerprint: 'local-fingerprint',
      port: 53317,
    });
    const internals = discovery as unknown as {
      socket: unknown;
      announceTimer: NodeJS.Timeout | null;
      pruneTimer: NodeJS.Timeout | null;
    };
    discovery.start();
    discovery.stop();
    socket.bindCallback?.();
    assert.equal(internals.socket, null);
    assert.equal(internals.announceTimer, null);
    assert.equal(internals.pruneTimer, null);
    assert.equal(socket.closeCalls, 2);
  } finally {
    dgramMutable.createSocket = originalCreateSocket;
  }
});

test('receiver: denies uploads by default and requires an explicit approval decision', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nt-ls-approval-'));
  const receiver = new LocalSendReceiver({ port: 0, alias: 'approval-test', fingerprint: 'approval-fp', receiveDir: dir });
  try {
    await receiver.start();
    const response = await prepareUpload(receiverPort(receiver), {
      f1: { id: 'f1', fileName: 'blocked.txt', size: 1, fileType: 'file' },
    });
    assert.equal(response.status, 403);
    assert.deepEqual(receiveScratchDirs(dir), []);
  } finally {
    await receiver.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('receiver: approval receives validated sender metadata, PIN, and remote address', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nt-ls-pin-'));
  let approval: import('../src/index.js').LocalSendUploadApproval | null = null;
  const receiver = new LocalSendReceiver({
    port: 0,
    alias: 'pin-test',
    fingerprint: 'pin-fp',
    receiveDir: dir,
    authorizeUpload: (request) => {
      approval = request;
      return request.pin === '123456';
    },
  });
  try {
    await receiver.start();
    const port = receiverPort(receiver);
    const senderInfo = createDeviceInfo({ alias: 'approved-sender', fingerprint: 'sender-fp', port: 12345 });
    const response = await fetch(`http://127.0.0.1:${port}${LOCALSEND_API_PREFIX}/prepare-upload?pin=123456`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        info: senderInfo,
        files: { f1: { id: 'f1', fileName: 'approved.txt', size: 1, fileType: 'file' } },
      }),
    });
    assert.equal(response.status, 200);
    assert.ok(approval);
    assert.equal(approval.sender.alias, 'approved-sender');
    assert.equal(approval.pin, '123456');
    assert.ok(approval.remoteAddress.includes('127.0.0.1'));
    const manifest = await response.json() as { sessionId: string };
    await cancelSession(port, manifest.sessionId);
  } finally {
    await receiver.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('receiver: bounds pending sessions per remote address', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nt-ls-per-ip-'));
  const receiver = new LocalSendReceiver({
    port: 0,
    alias: 'per-ip-test',
    fingerprint: 'per-ip-fp',
    receiveDir: dir,
    maxSessionsPerIp: 1,
    authorizeUpload: () => true,
  });
  try {
    await receiver.start();
    const port = receiverPort(receiver);
    const first = await prepareUpload(port, { f1: { id: 'f1', fileName: 'one.txt', size: 1, fileType: 'file' } });
    assert.equal(first.status, 200);
    const firstManifest = await first.json() as { sessionId: string };
    const second = await prepareUpload(port, { f2: { id: 'f2', fileName: 'two.txt', size: 1, fileType: 'file' } });
    assert.equal(second.status, 429);
    await cancelSession(port, firstManifest.sessionId);
  } finally {
    await receiver.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('receiver: reserves session capacity while an approval is pending', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nt-ls-approval-permit-'));
  let resolveApproval: ((approved: boolean) => void) | null = null;
  let approvalCalls = 0;
  const receiver = new LocalSendReceiver({
    port: 0,
    alias: 'permit-test',
    fingerprint: 'permit-fp',
    receiveDir: dir,
    maxSessions: 1,
    maxSessionsPerIp: 1,
    authorizeUpload: () => {
      approvalCalls += 1;
      return new Promise<boolean>((resolve) => { resolveApproval = resolve; });
    },
  });
  try {
    await receiver.start();
    const port = receiverPort(receiver);
    const first = prepareUpload(port, { f1: { id: 'f1', fileName: 'one.txt', size: 1, fileType: 'file' } });
    while (approvalCalls === 0) await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await prepareUpload(port, { f2: { id: 'f2', fileName: 'two.txt', size: 1, fileType: 'file' } });
    assert.equal(second.status, 503);
    assert.equal(approvalCalls, 1);
    assert.ok(resolveApproval);
    resolveApproval!(true);
    const accepted = await first;
    assert.equal(accepted.status, 200);
    const manifest = await accepted.json() as { sessionId: string };
    await cancelSession(port, manifest.sessionId);
  } finally {
    await receiver.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('receiver: stop cancels pending approval work and permits a clean restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nt-ls-stop-approval-'));
  let approvalStarted = false;
  const receiver = new LocalSendReceiver({
    port: 0,
    alias: 'stop-approval-test',
    fingerprint: 'stop-approval-fp',
    receiveDir: dir,
    authorizeUpload: () => {
      approvalStarted = true;
      return new Promise<boolean>(() => {});
    },
  });
  try {
    await receiver.start();
    const pending = prepareUpload(receiverPort(receiver), {
      f1: { id: 'f1', fileName: 'pending.txt', size: 1, fileType: 'file' },
    }).catch(() => null);
    while (!approvalStarted) await new Promise((resolve) => setTimeout(resolve, 5));
    const stopped = await Promise.race([
      receiver.stop().then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1000)),
    ]);
    assert.equal(stopped, true);
    await pending;
    assert.deepEqual(receiveScratchDirs(dir), []);
    await receiver.start();
    assert.ok(receiverPort(receiver) > 0);
  } finally {
    await receiver.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('receiver: bounds incomplete request bodies with an idle deadline', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nt-ls-body-timeout-'));
  const receiver = new LocalSendReceiver({
    port: 0,
    alias: 'body-timeout-test',
    fingerprint: 'body-timeout-fp',
    receiveDir: dir,
    requestBodyTimeoutMs: 50,
  });
  try {
    await receiver.start();
    const outcome = await new Promise<'response' | 'closed'>((resolve) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port: receiverPort(receiver),
        path: `${LOCALSEND_API_PREFIX}/register`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': '100' },
      }, (res) => {
        res.resume();
        res.once('end', () => resolve('response'));
      });
      req.once('error', () => resolve('closed'));
      req.write('{');
    });
    assert.ok(outcome === 'response' || outcome === 'closed');
  } finally {
    await receiver.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('receiver: rejects destination file-name collisions before creating a session', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nt-ls-collisions-'));
  const receiver = new LocalSendReceiver({ port: 0, alias: 'collision-test', fingerprint: 'collision-fp', receiveDir: dir, authorizeUpload: () => true });
  try {
    await receiver.start();
    const port = receiverPort(receiver);
    for (const files of [
      {
        a: { id: 'a', fileName: 'Report.txt', size: 1, fileType: 'file' },
        b: { id: 'b', fileName: 'report.txt', size: 1, fileType: 'file' },
      },
      {
        a: { id: 'a', fileName: '\u00e9.txt', size: 1, fileType: 'file' },
        b: { id: 'b', fileName: 'e\u0301.txt', size: 1, fileType: 'file' },
      },
    ]) {
      const response = await prepareUpload(port, files);
      assert.equal(response.status, 400);
    }
    assert.deepEqual(receiveScratchDirs(dir), []);
  } finally {
    await receiver.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('receiver: concurrent start callers observe the same listen failure and can retry', async () => {
  const blocker = net.createServer();
  await new Promise<void>((resolve) => blocker.listen(0, '0.0.0.0', resolve));
  const address = blocker.address();
  assert.ok(address && typeof address === 'object');
  const dir = mkdtempSync(join(tmpdir(), 'nt-ls-start-'));
  const receiver = new LocalSendReceiver({
    port: address.port,
    alias: 'start-test',
    fingerprint: 'start-fp',
    receiveDir: dir,
  });
  try {
    const first = receiver.start();
    const second = receiver.start();
    assert.strictEqual(second, first);
    const results = await Promise.allSettled([first, second]);
    assert.deepEqual(results.map((result) => result.status), ['rejected', 'rejected']);
    await new Promise<void>((resolve) => blocker.close(() => resolve()));
    await receiver.start();
  } finally {
    if (blocker.listening) await new Promise<void>((resolve) => blocker.close(() => resolve()));
    await receiver.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('receiver: active upload refreshes the session idle deadline', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nt-ls-active-'));
  const receiver = new LocalSendReceiver({
    port: 0,
    alias: 'active-test',
    fingerprint: 'active-fp',
    receiveDir: dir,
    sessionTimeoutMs: 80,
    authorizeUpload: () => true,
  });
  try {
    await receiver.start();
    const port = receiverPort(receiver);
    const prepared = await prepareUpload(port, {
      f1: { id: 'f1', fileName: 'slow.bin', size: 3, fileType: 'file' },
    });
    const manifest = await prepared.json() as { sessionId: string; files: Record<string, string> };
    const result = await delayedUpload(port, manifest, 'f1', [Buffer.from('a'), Buffer.from('b'), Buffer.from('c')], 50);
    assert.equal(result.statusCode, 200);
    assert.deepEqual(readFileSync(join(dir, 'slow.bin')), Buffer.from('abc'));
  } finally {
    await receiver.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('receiver: completed approval checks do not retain lifecycle listeners', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nt-ls-approval-listeners-'));
  const receiver = new LocalSendReceiver({
    port: 0,
    alias: 'listener-test',
    fingerprint: 'listener-fp',
    receiveDir: dir,
    authorizeUpload: () => false,
  });
  try {
    await receiver.start();
    const signal = (receiver as unknown as { lifecycleController: { signal: AbortSignal } }).lifecycleController.signal;
    for (let index = 0; index < 20; index += 1) {
      const response = await prepareUpload(receiverPort(receiver), {
        file: { id: 'file', fileName: `file-${index}.txt`, size: 1, fileType: 'file' },
      });
      assert.equal(response.status, 403);
      assert.equal(getEventListeners(signal, 'abort').length, 0);
    }
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

function delayedUpload(
  port: number,
  manifest: { sessionId: string; files: Record<string, string> },
  fileId: string,
  chunks: Buffer[],
  intervalMs: number,
): Promise<{ statusCode: number }> {
  return new Promise((resolve, reject) => {
    const token = manifest.files[fileId];
    assert.ok(token);
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: `${LOCALSEND_API_PREFIX}/upload?sessionId=${manifest.sessionId}&fileId=${fileId}&token=${token}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(chunks.reduce((sum, chunk) => sum + chunk.length, 0)) },
    }, (res) => {
      res.resume();
      res.on('end', () => resolve({ statusCode: res.statusCode ?? 0 }));
    });
    req.on('error', reject);
    let index = 0;
    const writeNext = () => {
      if (index >= chunks.length) {
        req.end();
        return;
      }
      req.write(chunks[index++]);
      setTimeout(writeNext, intervalMs);
    };
    writeNext();
  });
}

function localSendTarget(
  port: number,
  protocol: 'http' | 'https' = 'http',
  fingerprint = 'target-fingerprint',
): LocalSendDevice {
  return {
    fingerprint,
    alias: 'target',
    host: '127.0.0.1',
    port,
    protocol,
    deviceType: 'headless',
    deviceModel: 'test',
    version: '2.0',
    download: false,
  };
}

function listen(server: http.Server | https.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      const address = server.address();
      assert.ok(address && typeof address === 'object');
      resolve(address.port);
    });
  });
}

function closeServer(server: http.Server | https.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

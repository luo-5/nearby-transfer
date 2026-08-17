const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const {
  createX25519KeyPair,
  deriveTransferKey,
  EncryptFrameStream,
  signTransferRequest
} = require('../src/core/crypto');
const { loadOrCreateDevice } = require('../src/core/config');
const { TransferServer } = require('../src/core/server');
const { sendFile } = require('../src/core/transfer');

async function main() {
  const tempParent = path.join(__dirname, '..', '.tmp');
  fs.mkdirSync(tempParent, { recursive: true });
  const tempRoot = fs.mkdtempSync(path.join(tempParent, 'lan-transfer-test-'));
  const senderDir = path.join(tempRoot, 'sender');
  const receiverDir = path.join(tempRoot, 'receiver');
  const saveDir = path.join(tempRoot, 'save');
  fs.mkdirSync(senderDir);
  fs.mkdirSync(receiverDir);
  fs.mkdirSync(saveDir);

  const sender = loadOrCreateDevice(senderDir);
  const receiver = loadOrCreateDevice(receiverDir);
  const sourcePath = path.join(tempRoot, 'sample.txt');
  const source = Buffer.from('local encrypted transfer smoke test'.repeat(2048));
  fs.writeFileSync(sourcePath, source);

  const events = [];
  const server = new TransferServer({
    device: receiver,
    saveDirectory: saveDir,
    onIncomingRequest: async () => ({ accepted: true }),
    onTransferEvent: (event) => events.push(event)
  });

  try {
    const port = await server.start(0);
    await sendFile({
      device: sender,
      filePath: sourcePath,
      peer: {
        deviceId: receiver.deviceId,
        deviceName: receiver.deviceName,
        host: '127.0.0.1',
        port,
        fingerprint: receiver.fingerprint,
        encryptionPublicKey: receiver.encryptionPublicKey,
        signingPublicKey: receiver.signingPublicKey
      }
    });

    const savedPath = path.join(saveDir, 'sample.txt');
    assert.deepStrictEqual(fs.readFileSync(savedPath), source);
    assert(events.some((event) => event.status === 'completed'));

    await assertSenderDeviceIdRejected({ sender, port });
    await assertOversizedUploadRejected({ sender, receiver, port, saveDir, events });
    await assertTransferRequestRateLimit({ sender, receiver, saveDir });
    await assertPendingTransferLimits({ sender, receiver, saveDir });
  } finally {
    server.stop();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

async function assertSenderDeviceIdRejected(options) {
  const transferId = 'sender-device-id-smoke-test';
  const ephemeral = createX25519KeyPair();
  const requestPayload = {
    protocolVersion: 1,
    transferId,
    sender: {
      deviceId: '0000000000000000',
      deviceName: options.sender.deviceName,
      fingerprint: options.sender.fingerprint,
      signingPublicKey: options.sender.signingPublicKey
    },
    file: {
      name: 'bad-device-id.txt',
      size: 0,
      sha256: crypto.createHash('sha256').digest('hex')
    },
    senderEphemeralPublicKey: ephemeral.publicKey
  };
  requestPayload.signature = signTransferRequest(requestPayload, options.sender.signingPrivateKey);

  const result = await postJsonWithStatus(options.port, '/transfer/request', requestPayload);
  assert.strictEqual(result.statusCode, 400);
  assert.strictEqual(result.body.error, 'Sender device ID does not match identity key');
}

async function assertOversizedUploadRejected(options) {
  const transferId = 'oversized-upload-smoke-test';
  const ephemeral = createX25519KeyPair();
  const payload = Buffer.from('aa');
  const declared = Buffer.from('a');
  const requestPayload = {
    protocolVersion: 1,
    transferId,
    sender: {
      deviceId: options.sender.deviceId,
      deviceName: options.sender.deviceName,
      fingerprint: options.sender.fingerprint,
      signingPublicKey: options.sender.signingPublicKey
    },
    file: {
      name: 'oversized.txt',
      size: declared.length,
      sha256: crypto.createHash('sha256').update(declared).digest('hex')
    },
    senderEphemeralPublicKey: ephemeral.publicKey
  };
  requestPayload.signature = signTransferRequest(requestPayload, options.sender.signingPrivateKey);

  const decision = await postJson(options.port, '/transfer/request', requestPayload);
  assert.strictEqual(decision.accepted, true);

  const key = deriveTransferKey(ephemeral.privateKey, options.receiver.encryptionPublicKey, transferId);
  const uploadResult = await postEncrypted(options.port, `/transfer/upload/${encodeURIComponent(transferId)}`, payload, key);
  assert.strictEqual(uploadResult.statusCode, 400);
  assert(uploadResult.body.error.includes('larger than declared size'));
  assert(!fs.existsSync(path.join(options.saveDir, 'oversized.txt')));
  assert(options.events.some((event) => event.transferId === transferId && event.status === 'failed'));
}

async function assertTransferRequestRateLimit(options) {
  let promptCount = 0;
  const server = new TransferServer({
    device: options.receiver,
    saveDirectory: options.saveDir,
    transferRequestLimit: 2,
    transferRequestWindowMs: 60000,
    onIncomingRequest: async () => {
      promptCount += 1;
      return { accepted: false };
    }
  });

  try {
    const port = await server.start(0);
    const first = await postJsonWithStatus(port, '/transfer/request', createSignedRequest(options.sender, 'rate-limit-1'));
    const second = await postJsonWithStatus(port, '/transfer/request', createSignedRequest(options.sender, 'rate-limit-2'));
    const blocked = await postJsonWithStatus(port, '/transfer/request', createSignedRequest(options.sender, 'rate-limit-3'));

    assert.strictEqual(first.statusCode, 200);
    assert.strictEqual(second.statusCode, 200);
    assert.strictEqual(blocked.statusCode, 429);
    assert.strictEqual(blocked.body.error, 'Too many transfer requests');
    assert(Number(blocked.headers['retry-after']) >= 1);
    assert.strictEqual(promptCount, 2);
  } finally {
    server.stop();
  }
}

async function assertPendingTransferLimits(options) {
  const server = new TransferServer({
    device: options.receiver,
    saveDirectory: options.saveDir,
    maxPendingTransfers: 1,
    onIncomingRequest: async () => ({ accepted: true })
  });

  try {
    const port = await server.start(0);
    const firstPayload = createSignedRequest(options.sender, 'pending-limit-1');
    const accepted = await postJsonWithStatus(port, '/transfer/request', firstPayload);
    const duplicate = await postJsonWithStatus(port, '/transfer/request', firstPayload);
    const full = await postJsonWithStatus(port, '/transfer/request', createSignedRequest(options.sender, 'pending-limit-2'));

    assert.strictEqual(accepted.statusCode, 200);
    assert.strictEqual(accepted.body.accepted, true);
    assert.strictEqual(duplicate.statusCode, 409);
    assert.strictEqual(duplicate.body.error, 'Transfer ID is already pending');
    assert.strictEqual(full.statusCode, 503);
    assert.strictEqual(full.body.error, 'Too many pending transfers');
  } finally {
    server.stop();
  }
}

function createSignedRequest(sender, transferId) {
  const ephemeral = createX25519KeyPair();
  const payload = {
    protocolVersion: 1,
    transferId,
    sender: {
      deviceId: sender.deviceId,
      deviceName: sender.deviceName,
      fingerprint: sender.fingerprint,
      signingPublicKey: sender.signingPublicKey
    },
    file: {
      name: transferId + '.txt',
      size: 0,
      sha256: crypto.createHash('sha256').digest('hex')
    },
    senderEphemeralPublicKey: ephemeral.publicKey
  };
  payload.signature = signTransferRequest(payload, sender.signingPrivateKey);
  return payload;
}

function postJsonWithStatus(port, requestPath, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: '127.0.0.1',
      port,
      path: requestPath,
      method: 'POST',
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'content-length': body.length
      }
    }, (response) => collectJson(response, (body) => resolve({ statusCode: response.statusCode, headers: response.headers, body }), reject));
    request.on('error', reject);
    request.end(body);
  });
}

function postJson(port, requestPath, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: '127.0.0.1',
      port,
      path: requestPath,
      method: 'POST',
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'content-length': body.length
      }
    }, (response) => collectJson(response, resolve, reject));
    request.on('error', reject);
    request.end(body);
  });
}

function postEncrypted(port, requestPath, payload, key) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: '127.0.0.1',
      port,
      path: requestPath,
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream'
      }
    }, (response) => collectJson(response, (body) => resolve({ statusCode: response.statusCode, body }), reject));
    request.on('error', reject);
    pipeline(Readable.from([payload]), new EncryptFrameStream(key), request).catch(reject);
  });
}

function collectJson(response, resolve, reject) {
  const chunks = [];
  response.on('data', (chunk) => chunks.push(chunk));
  response.on('error', reject);
  response.on('end', () => {
    try {
      resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
    } catch (error) {
      reject(error);
    }
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

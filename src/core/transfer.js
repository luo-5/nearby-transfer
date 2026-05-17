const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');
const {
  EncryptFrameStream,
  createX25519KeyPair,
  deriveTransferKey,
  signTransferRequest,
  sha256File
} = require('./crypto');

const FILE_STREAM_CHUNK_BYTES = 1024 * 1024;
const PROGRESS_MIN_BYTES = 1024 * 1024;
const PROGRESS_MIN_MS = 250;
const UPLOAD_IDLE_TIMEOUT_MS = 10 * 60 * 1000;

async function sendFile(options) {
  const peer = options.peer;
  const filePath = options.filePath;
  const device = options.device;
  const onTransferEvent = options.onTransferEvent || (() => {});

  if (!peer) {
    throw new Error('Missing target peer');
  }
  const stat = await fs.promises.stat(filePath);
  if (!stat.isFile()) {
    throw new Error('Only regular files can be sent');
  }

  const transferId = createTransferId();
  const fileName = path.basename(filePath);
  const fileSha256 = await sha256File(filePath);
  const ephemeral = createX25519KeyPair();
  const key = deriveTransferKey(ephemeral.privateKey, peer.encryptionPublicKey, transferId);
  const file = {
    name: fileName,
    size: stat.size,
    sha256: fileSha256
  };

  onTransferEvent({
    transferId,
    direction: 'send',
    status: 'requesting',
    peer,
    file,
    bytes: 0,
    total: stat.size
  });

  let sent = 0;

  try {
    const requestPayload = {
      protocolVersion: 1,
      transferId,
      sender: {
        deviceId: device.deviceId,
        deviceName: device.deviceName,
        fingerprint: device.fingerprint,
        signingPublicKey: device.signingPublicKey
      },
      file,
      senderEphemeralPublicKey: ephemeral.publicKey
    };
    requestPayload.signature = signTransferRequest(requestPayload, device.signingPrivateKey);

    const decision = await postJson(peer, '/transfer/request', requestPayload, 120000);

    if (!decision.accepted) {
      onTransferEvent({
        transferId,
        direction: 'send',
        status: 'rejected',
        peer,
        file,
        bytes: 0,
        total: stat.size
      });
      throw new TransferRejectedError('Receiver rejected the transfer');
    }

    const shouldEmitProgress = createProgressLimiter();
    const progress = new Transform({
      transform: (chunk, _encoding, callback) => {
        sent += chunk.length;
        if (shouldEmitProgress(chunk.length, sent, stat.size)) {
          onTransferEvent({
            transferId,
            direction: 'send',
            status: 'sending',
            peer,
            file,
            bytes: sent,
            total: stat.size
          });
        }
        callback(null, chunk);
      }
    });

    const result = await postStreamPipeline(
      peer,
      `/transfer/upload/${encodeURIComponent(transferId)}`,
      [
        fs.createReadStream(filePath, { highWaterMark: FILE_STREAM_CHUNK_BYTES }),
        progress,
        new EncryptFrameStream(key)
      ],
      {
        'content-type': 'application/octet-stream'
      },
      UPLOAD_IDLE_TIMEOUT_MS
    );

    onTransferEvent({
      transferId,
      direction: 'send',
      status: 'completed',
      peer,
      file,
      bytes: sent,
      total: stat.size
    });

    return result;
  } catch (error) {
    if (!(error instanceof TransferRejectedError)) {
      onTransferEvent({
        transferId,
        direction: 'send',
        status: 'failed',
        peer,
        file,
        bytes: sent,
        total: stat.size,
        error: error.message
      });
    }
    throw error;
  }
}

class TransferRejectedError extends Error {}

function createProgressLimiter() {
  let bytesSinceLastEvent = 0;
  let lastEventAt = 0;
  return (deltaBytes, currentBytes, totalBytes) => {
    bytesSinceLastEvent += deltaBytes;
    const now = Date.now();
    const isComplete = totalBytes > 0 && currentBytes >= totalBytes;
    if (isComplete || bytesSinceLastEvent >= PROGRESS_MIN_BYTES || now - lastEventAt >= PROGRESS_MIN_MS) {
      bytesSinceLastEvent = 0;
      lastEventAt = now;
      return true;
    }
    return false;
  };
}

function createTransferId() {
  if (crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return crypto.randomBytes(16).toString('hex');
}

function postJson(peer, requestPath, payload, timeoutMs) {
  const body = Buffer.from(JSON.stringify(payload));
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: peer.host,
      port: peer.port,
      path: requestPath,
      method: 'POST',
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'content-length': body.length
      }
    }, (response) => collectJsonResponse(response, resolve, reject));

    request.on('error', reject);
    if (timeoutMs) {
      request.setTimeout(timeoutMs, () => request.destroy(new Error('Request timed out')));
    }
    request.end(body);
  });
}

function postStreamPipeline(peer, requestPath, streams, headers, timeoutMs) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: peer.host,
      port: peer.port,
      path: requestPath,
      method: 'POST',
      headers
    }, (response) => collectJsonResponse(response, resolve, reject));

    request.on('error', reject);
    if (timeoutMs) {
      request.setTimeout(timeoutMs, () => request.destroy(new Error('Upload timed out')));
    }

    pipeline(...streams, request).catch(reject);
  });
}

function collectJsonResponse(response, resolve, reject) {
  const chunks = [];
  response.on('data', (chunk) => chunks.push(chunk));
  response.on('error', reject);
  response.on('end', () => {
    let payload = {};
    const raw = Buffer.concat(chunks).toString('utf8');
    if (raw) {
      try {
        payload = JSON.parse(raw);
      } catch (_error) {
        reject(new Error('Peer returned invalid JSON'));
        return;
      }
    }

    if (response.statusCode < 200 || response.statusCode >= 300) {
      reject(new Error(payload.error || `Peer returned HTTP ${response.statusCode}`));
      return;
    }
    resolve(payload);
  });
}

module.exports = {
  sendFile
};

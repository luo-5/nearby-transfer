const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');
const { DecryptFrameStream, deriveTransferKey, fingerprintFor, verifyTransferRequest } = require('./crypto');
const { safeFilename, uniqueDestinationPath } = require('./path-utils');

const REQUEST_BODY_LIMIT = 1024 * 1024;
const PENDING_TTL_MS = 5 * 60 * 1000;
const FILE_STREAM_CHUNK_BYTES = 1024 * 1024;
const PROGRESS_MIN_BYTES = 1024 * 1024;
const PROGRESS_MIN_MS = 250;
const UPLOAD_IDLE_TIMEOUT_MS = 10 * 60 * 1000;

class TransferServer {
  constructor(options) {
    this.device = options.device;
    this.saveDirectory = options.saveDirectory || process.cwd();
    this.onIncomingRequest = options.onIncomingRequest || (async () => ({ accepted: false }));
    this.onTransferEvent = options.onTransferEvent || (() => {});
    this.server = null;
    this.port = null;
    this.pending = new Map();
    this.cleanupTimer = null;
  }

  start(port) {
    if (this.server) {
      return Promise.resolve(this.port);
    }

    fs.mkdirSync(this.saveDirectory, { recursive: true });
    this.server = http.createServer((request, response) => {
      this._handleRequest(request, response).catch((error) => {
        respondJson(response, 500, { ok: false, error: error.message });
      });
    });
    this.server.timeout = UPLOAD_IDLE_TIMEOUT_MS;

    return new Promise((resolve, reject) => {
      this.server.on('error', reject);
      this.server.listen(port || 0, '0.0.0.0', () => {
        this.port = this.server.address().port;
        this.cleanupTimer = setInterval(() => this._cleanupPending(), 30000);
        resolve(this.port);
      });
    });
  }

  stop() {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }

  setSaveDirectory(saveDirectory) {
    fs.mkdirSync(saveDirectory, { recursive: true });
    this.saveDirectory = saveDirectory;
  }

  async _handleRequest(request, response) {
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);

    if (request.method === 'GET' && url.pathname === '/health') {
      respondJson(response, 200, { ok: true, deviceId: this.device.deviceId });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/transfer/request') {
      await this._handleTransferRequest(request, response);
      return;
    }

    if (request.method === 'POST' && url.pathname.startsWith('/transfer/upload/')) {
      const transferId = decodeURIComponent(url.pathname.slice('/transfer/upload/'.length));
      await this._handleUpload(transferId, request, response);
      return;
    }

    respondJson(response, 404, { ok: false, error: 'Not found' });
  }

  async _handleTransferRequest(request, response) {
    const payload = await readJsonBody(request, REQUEST_BODY_LIMIT);
    const validationError = validateTransferRequest(payload);
    if (validationError) {
      respondJson(response, 400, { ok: false, error: validationError });
      return;
    }
    if (!verifyTransferRequest(payload, payload.signature, payload.sender.signingPublicKey)) {
      respondJson(response, 400, { ok: false, error: 'Invalid transfer request signature' });
      return;
    }
    if (payload.sender.fingerprint !== fingerprintFor(payload.sender.signingPublicKey)) {
      respondJson(response, 400, { ok: false, error: 'Sender fingerprint does not match identity key' });
      return;
    }
    if (payload.sender.deviceId !== deviceIdForSigningKey(payload.sender.signingPublicKey)) {
      respondJson(response, 400, { ok: false, error: 'Sender device ID does not match identity key' });
      return;
    }

    const transferId = payload.transferId;
    const safeName = safeFilename(payload.file.name);
    const savePath = uniqueDestinationPath(this.saveDirectory, safeName);
    const key = deriveTransferKey(
      this.device.encryptionPrivateKey,
      payload.senderEphemeralPublicKey,
      transferId
    );

    const incoming = {
      transferId,
      sender: payload.sender,
      file: {
        name: safeName,
        originalName: payload.file.name,
        size: payload.file.size,
        sha256: payload.file.sha256
      },
      saveDirectory: this.saveDirectory,
      savePath
    };

    const decision = await this.onIncomingRequest(incoming);
    if (!decision || !decision.accepted) {
      this.onTransferEvent(Object.assign({}, incoming, {
        direction: 'receive',
        status: 'rejected',
        bytes: 0,
        total: incoming.file.size
      }));
      respondJson(response, 200, { accepted: false });
      return;
    }

    this.pending.set(transferId, {
      createdAt: Date.now(),
      key,
      sender: incoming.sender,
      file: incoming.file,
      savePath: incoming.savePath
    });
    this.onTransferEvent(Object.assign({}, incoming, {
      direction: 'receive',
      status: 'accepted',
      bytes: 0,
      total: incoming.file.size
    }));
    respondJson(response, 200, { accepted: true, transferId });
  }

  async _handleUpload(transferId, request, response) {
    const pending = this.pending.get(transferId);
    if (!pending) {
      respondJson(response, 404, { ok: false, error: 'Transfer is not pending or was already used' });
      return;
    }
    this.pending.delete(transferId);
    request.setTimeout(UPLOAD_IDLE_TIMEOUT_MS, () => request.destroy(new Error('Upload timed out')));

    const tempPath = `${pending.savePath}.part-${process.pid}-${Date.now()}`;
    const hash = crypto.createHash('sha256');
    let received = 0;
    const shouldEmitProgress = createProgressLimiter();
    const progress = new Transform({
      transform: (chunk, _encoding, callback) => {
        received += chunk.length;
        if (received > pending.file.size) {
          callback(new Error('Received file is larger than declared size'));
          return;
        }
        hash.update(chunk);
        if (shouldEmitProgress(chunk.length, received, pending.file.size)) {
          this.onTransferEvent({
            transferId,
            direction: 'receive',
            status: 'receiving',
            sender: pending.sender,
            file: pending.file,
            bytes: received,
            total: pending.file.size,
            savePath: pending.savePath
          });
        }
        callback(null, chunk);
      }
    });

    try {
      await pipeline(
        request,
        new DecryptFrameStream(pending.key),
        progress,
        fs.createWriteStream(tempPath, { flags: 'wx', highWaterMark: FILE_STREAM_CHUNK_BYTES })
      );

      const actualSha256 = hash.digest('hex');
      if (received !== pending.file.size) {
        throw new Error('Received file size does not match metadata');
      }
      if (actualSha256 !== pending.file.sha256) {
        throw new Error('SHA-256 verification failed');
      }

      const finalPath = uniqueDestinationPath(path.dirname(pending.savePath), path.basename(pending.savePath));
      fs.renameSync(tempPath, finalPath);
      this.onTransferEvent({
        transferId,
        direction: 'receive',
        status: 'completed',
        sender: pending.sender,
        file: pending.file,
        bytes: received,
        total: pending.file.size,
        savePath: finalPath
      });
      respondJson(response, 200, { ok: true, sha256: actualSha256, path: finalPath });
    } catch (error) {
      safeUnlink(tempPath);
      this.onTransferEvent({
        transferId,
        direction: 'receive',
        status: 'failed',
        sender: pending.sender,
        file: pending.file,
        bytes: received,
        total: pending.file.size,
        savePath: pending.savePath,
        error: error.message
      });
      respondJson(response, 400, { ok: false, error: error.message });
    }
  }

  _cleanupPending() {
    const now = Date.now();
    for (const [transferId, pending] of this.pending.entries()) {
      if (now - pending.createdAt > PENDING_TTL_MS) {
        this.pending.delete(transferId);
      }
    }
  }
}

function validateTransferRequest(payload) {
  if (!payload || typeof payload !== 'object') {
    return 'Invalid request body';
  }
  if (!payload.transferId || typeof payload.transferId !== 'string') {
    return 'Missing transfer ID';
  }
  if (payload.protocolVersion !== 1) {
    return 'Unsupported protocol version';
  }
  if (!payload.sender || typeof payload.sender !== 'object') {
    return 'Missing sender metadata';
  }
  if (!payload.sender.deviceId || !payload.sender.deviceName || !payload.sender.fingerprint || !payload.sender.signingPublicKey) {
    return 'Incomplete sender metadata';
  }
  if (!payload.file || typeof payload.file !== 'object') {
    return 'Missing file metadata';
  }
  if (!payload.file.name || typeof payload.file.name !== 'string') {
    return 'Missing file name';
  }
  if (!Number.isSafeInteger(payload.file.size) || payload.file.size < 0) {
    return 'Invalid file size';
  }
  if (!/^[a-f0-9]{64}$/i.test(payload.file.sha256 || '')) {
    return 'Invalid file hash';
  }
  if (!payload.senderEphemeralPublicKey || typeof payload.senderEphemeralPublicKey !== 'string') {
    return 'Missing sender ephemeral public key';
  }
  if (!payload.signature || typeof payload.signature !== 'string') {
    return 'Missing transfer request signature';
  }
  return null;
}

function deviceIdForSigningKey(signingPublicKey) {
  return crypto.createHash('sha256').update(signingPublicKey).digest('hex').slice(0, 16);
}

function readJsonBody(request, limit) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];
    request.on('data', (chunk) => {
      total += chunk.length;
      if (total > limit) {
        reject(new Error('Request body is too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('error', reject);
    request.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (_error) {
        reject(new Error('Invalid JSON body'));
      }
    });
  });
}

function respondJson(response, statusCode, payload) {
  if (response.headersSent) {
    return;
  }
  const body = Buffer.from(JSON.stringify(payload));
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length
  });
  response.end(body);
}

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

function safeUnlink(filePath) {
  try {
    fs.unlinkSync(filePath);
  } catch (_error) {
    // Ignore cleanup failures for temporary files.
  }
}

module.exports = {
  TransferServer
};

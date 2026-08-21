const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');
const { DecryptFrameStream, deriveTransferKey, fingerprintFor, verifyTransferRequest } = require('./crypto');
const { ensureSafeDirectory, safeFilename, uniqueDestinationPath } = require('./path-utils');

const REQUEST_BODY_LIMIT = 1024 * 1024;
const PENDING_TTL_MS = 5 * 60 * 1000;
const FILE_STREAM_CHUNK_BYTES = 1024 * 1024;
const PROGRESS_MIN_BYTES = 1024 * 1024;
const PROGRESS_MIN_MS = 250;
const UPLOAD_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const TRANSFER_REQUEST_LIMIT = 20;
const TRANSFER_REQUEST_WINDOW_MS = 60 * 1000;
const MAX_PENDING_TRANSFERS = 32;

class TransferServer {
  constructor(options) {
    this.device = options.device;
    this.saveDirectory = ensureSafeDirectory(options.saveDirectory || process.cwd());
    this.onIncomingRequest = options.onIncomingRequest || (async () => ({ accepted: false }));
    this.onTransferEvent = options.onTransferEvent || (() => {});
    this.server = null;
    this.port = null;
    this.pending = new Map();
    this.activeIncoming = new Map();
    this.reservedTransferIds = new Set();
    this.requestWindows = new Map();
    this.transferRequestLimit = positiveIntegerOption(options.transferRequestLimit, TRANSFER_REQUEST_LIMIT);
    this.transferRequestWindowMs = positiveIntegerOption(options.transferRequestWindowMs, TRANSFER_REQUEST_WINDOW_MS);
    this.maxPendingTransfers = positiveIntegerOption(options.maxPendingTransfers, MAX_PENDING_TRANSFERS);
    this.cleanupTimer = null;
  }

  cancelTransfer(transferId) {
    const active = this.activeIncoming.get(transferId);
    if (active) {
      try {
        active.request.destroy(new Error('用户已主动取消接收'));
      } catch (_) {}
      this.activeIncoming.delete(transferId);
      return true;
    }
    return false;
  }

  start(port) {
    if (this.server) {
      return Promise.resolve(this.port);
    }

    this.saveDirectory = ensureSafeDirectory(this.saveDirectory);
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
    this.reservedTransferIds.clear();
    this.requestWindows.clear();
    this.activeIncoming.clear();
  }

  setSaveDirectory(saveDirectory) {
    this.saveDirectory = ensureSafeDirectory(saveDirectory);
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
    const rateLimit = this._consumeTransferRequest(request.socket.remoteAddress || 'unknown');
    if (!rateLimit.allowed) {
      response.setHeader('retry-after', String(rateLimit.retryAfterSeconds));
      respondJson(response, 429, { ok: false, error: 'Too many transfer requests' });
      return;
    }

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
    if (this.pending.has(transferId) || this.reservedTransferIds.has(transferId)) {
      respondJson(response, 409, { ok: false, error: 'Transfer ID is already pending' });
      return;
    }
    if (this.pending.size + this.reservedTransferIds.size >= this.maxPendingTransfers) {
      respondJson(response, 503, { ok: false, error: 'Too many pending transfers' });
      return;
    }

    this.reservedTransferIds.add(transferId);
    try {
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

      const diskSpace = await checkAvailableDiskSpace(this.saveDirectory);
      const MIN_SAFETY_BUFFER = 50 * 1024 * 1024; // 50MB
      if (diskSpace !== null && diskSpace < payload.file.size + MIN_SAFETY_BUFFER) {
        const errorMsg = `接收端磁盘可用空间不足 (需要 ${formatBytes(payload.file.size)}，可用 ${formatBytes(diskSpace)})`;
        this.onTransferEvent(Object.assign({}, incoming, {
          direction: 'receive',
          status: 'rejected',
          error: errorMsg,
          bytes: 0,
          total: incoming.file.size
        }));
        respondJson(response, 507, { accepted: false, error: errorMsg });
        return;
      }

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
    } finally {
      this.reservedTransferIds.delete(transferId);
    }
  }

  async _handleUpload(transferId, request, response) {
    const pending = this.pending.get(transferId);
    if (!pending) {
      respondJson(response, 404, { ok: false, error: 'Transfer is not pending or was already used' });
      return;
    }
    this.pending.delete(transferId);
    request.setTimeout(UPLOAD_IDLE_TIMEOUT_MS, () => request.destroy(new Error('Upload timed out')));

    const tempPath = `${pending.savePath}.part-${process.pid}-${crypto.randomBytes(8).toString('hex')}`;
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

    this.activeIncoming.set(transferId, { request, response, tempPath });

    try {
      const decrypted = new DecryptFrameStream(pending.key, pending.file.sha256, pending.file.size);
      await pipeline(request, decrypted, progress, fs.createWriteStream(tempPath, {
        flags: 'wx',
        highWaterMark: FILE_STREAM_CHUNK_BYTES
      }));
      if (received !== pending.file.size) {
        throw new Error('Received file size does not match declared size');
      }
      const receivedHash = hash.digest('hex');
      if (receivedHash !== pending.file.sha256) {
        throw new Error('Received file hash does not match declared hash');
      }
      const finalPath = commitTempFileWithoutOverwrite(
        tempPath,
        path.dirname(pending.savePath),
        path.basename(pending.savePath)
      );
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
      respondJson(response, 200, { ok: true, sha256: receivedHash, path: finalPath });
    } catch (error) {
      safeRemove(tempPath);
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
    } finally {
      this.activeIncoming.delete(transferId);
    }
  }

  _cleanupPending() {
    const now = Date.now();
    for (const [transferId, pending] of this.pending.entries()) {
      if (now - pending.createdAt <= PENDING_TTL_MS) {
        continue;
      }
      this.pending.delete(transferId);
      this.onTransferEvent({
        transferId,
        direction: 'receive',
        status: 'expired',
        sender: pending.sender,
        file: pending.file,
        bytes: 0,
        total: pending.file.size,
        savePath: pending.savePath
      });
    }
    for (const [remoteAddress, window] of this.requestWindows.entries()) {
      if (now - window.startedAt >= this.transferRequestWindowMs) {
        this.requestWindows.delete(remoteAddress);
      }
    }
  }

  _consumeTransferRequest(remoteAddress) {
    const now = Date.now();
    let window = this.requestWindows.get(remoteAddress);
    if (!window || now - window.startedAt >= this.transferRequestWindowMs) {
      window = { startedAt: now, count: 0 };
      this.requestWindows.set(remoteAddress, window);
    }
    if (window.count >= this.transferRequestLimit) {
      const remainingMs = Math.max(1, this.transferRequestWindowMs - (now - window.startedAt));
      return { allowed: false, retryAfterSeconds: Math.ceil(remainingMs / 1000) };
    }
    window.count += 1;
    return { allowed: true, retryAfterSeconds: 0 };
  }
}

function positiveIntegerOption(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
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
    request.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (error) {
        reject(error);
      }
    });
    request.on('error', reject);
  });
}

function validateTransferRequest(payload) {
  if (!payload || typeof payload !== 'object') {
    return 'Invalid transfer request body';
  }
  if (payload.protocolVersion !== 1) {
    return 'Unsupported protocol version';
  }
  if (!payload.transferId || typeof payload.transferId !== 'string') {
    return 'Invalid transfer ID';
  }
  if (!payload.sender || typeof payload.sender !== 'object') {
    return 'Invalid sender';
  }
  if (!payload.file || typeof payload.file !== 'object') {
    return 'Invalid file';
  }
  if (!payload.file.name || typeof payload.file.name !== 'string') {
    return 'Invalid file name';
  }
  if (!Number.isSafeInteger(payload.file.size) || payload.file.size < 0) {
    return 'Invalid file size';
  }
  if (typeof payload.file.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(payload.file.sha256)) {
    return 'Invalid file hash';
  }
  if (typeof payload.senderEphemeralPublicKey !== 'string' || !payload.senderEphemeralPublicKey) {
    return 'Invalid sender ephemeral public key';
  }
  if (typeof payload.signature !== 'string' || !payload.signature) {
    return 'Invalid signature';
  }
  if (!payload.sender.deviceId || typeof payload.sender.deviceId !== 'string') {
    return 'Invalid sender device ID';
  }
  if (!payload.sender.deviceName || typeof payload.sender.deviceName !== 'string') {
    return 'Invalid sender device name';
  }
  if (!payload.sender.fingerprint || typeof payload.sender.fingerprint !== 'string') {
    return 'Invalid sender fingerprint';
  }
  if (!payload.sender.signingPublicKey || typeof payload.sender.signingPublicKey !== 'string') {
    return 'Invalid sender signing public key';
  }
  return null;
}

function deviceIdForSigningKey(signingPublicKey) {
  const hash = crypto.createHash('sha256').update(signingPublicKey).digest('hex');
  return hash.slice(0, 16);
}

function safeRemove(target) {
  try {
    fs.rmSync(target, { force: true });
  } catch (_) {
    // ignore cleanup errors
  }
}

function commitTempFileWithoutOverwrite(tempPath, directory, fileName) {
  while (true) {
    const candidate = uniqueDestinationPath(directory, fileName);
    try {
      fs.linkSync(tempPath, candidate);
      safeRemove(tempPath);
      return candidate;
    } catch (error) {
      if (error && error.code === 'EEXIST') {
        continue;
      }
      if (!error || !['EACCES', 'ENOTSUP', 'EPERM', 'EXDEV'].includes(error.code)) {
        throw error;
      }
    }

    try {
      fs.copyFileSync(tempPath, candidate, fs.constants.COPYFILE_EXCL);
      safeRemove(tempPath);
      return candidate;
    } catch (error) {
      if (error && error.code === 'EEXIST') {
        continue;
      }
      throw error;
    }
  }
}

function createProgressLimiter() {
  let lastBytes = 0;
  let lastEmit = 0;
  return (deltaBytes, totalBytes, fileSize) => {
    const now = Date.now();
    if (totalBytes === fileSize) {
      lastBytes = totalBytes;
      lastEmit = now;
      return true;
    }
    if (totalBytes - lastBytes >= PROGRESS_MIN_BYTES || now - lastEmit >= PROGRESS_MIN_MS) {
      lastBytes = totalBytes;
      lastEmit = now;
      return true;
    }
    return false;
  };
}

function respondJson(response, statusCode, payload) {
  response.statusCode = statusCode;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.end(JSON.stringify(payload));
}

async function checkAvailableDiskSpace(targetDirectory) {
  if (typeof fs.promises.statfs === 'function') {
    try {
      const stats = await fs.promises.statfs(targetDirectory);
      return Number(stats.bavail) * Number(stats.bsize);
    } catch (_) {
      return null;
    }
  }
  return null;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

module.exports = TransferServer;
module.exports.TransferServer = TransferServer;

const crypto = require('crypto');
const fs = require('fs');
const { Transform } = require('stream');

const FRAME_HEADER_BYTES = 32;
const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const HASH_STREAM_CHUNK_BYTES = 1024 * 1024;

function createKeyPair(type) {
  return crypto.generateKeyPairSync(type, {
    publicKeyEncoding: {
      type: 'spki',
      format: 'pem'
    },
    privateKeyEncoding: {
      type: 'pkcs8',
      format: 'pem'
    }
  });
}

function createX25519KeyPair() {
  return createKeyPair('x25519');
}

function deriveTransferKey(localPrivateKeyPem, remotePublicKeyPem, transferId) {
  const secret = crypto.diffieHellman({
    privateKey: crypto.createPrivateKey(localPrivateKeyPem),
    publicKey: crypto.createPublicKey(remotePublicKeyPem)
  });
  const salt = Buffer.from(`lan-transfer-v1:${transferId}`, 'utf8');
  const info = Buffer.from('file-content', 'utf8');
  return Buffer.from(crypto.hkdfSync('sha256', secret, salt, info, 32));
}

function fingerprintFor(publicKeyPem) {
  const hex = crypto.createHash('sha256').update(publicKeyPem).digest('hex').toUpperCase();
  return hex.match(/.{1,4}/g).slice(0, 6).join('-');
}

function signTransferRequest(payload, privateKeyPem) {
  const message = Buffer.from(transferRequestSigningPayload(payload), 'utf8');
  return crypto.sign(null, message, crypto.createPrivateKey(privateKeyPem)).toString('base64');
}

function verifyTransferRequest(payload, signature, publicKeyPem) {
  if (!signature || typeof signature !== 'string') {
    return false;
  }

  try {
    const message = Buffer.from(transferRequestSigningPayload(payload), 'utf8');
    return crypto.verify(
      null,
      message,
      crypto.createPublicKey(publicKeyPem),
      Buffer.from(signature, 'base64')
    );
  } catch (_error) {
    return false;
  }
}

function transferRequestSigningPayload(payload) {
  return JSON.stringify({
    protocolVersion: payload.protocolVersion,
    transferId: payload.transferId,
    sender: {
      deviceId: payload.sender && payload.sender.deviceId,
      deviceName: payload.sender && payload.sender.deviceName,
      fingerprint: payload.sender && payload.sender.fingerprint,
      signingPublicKey: payload.sender && payload.sender.signingPublicKey
    },
    file: {
      name: payload.file && payload.file.name,
      size: payload.file && payload.file.size,
      sha256: payload.file && payload.file.sha256
    },
    senderEphemeralPublicKey: payload.senderEphemeralPublicKey
  });
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath, { highWaterMark: HASH_STREAM_CHUNK_BYTES });
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

class EncryptFrameStream extends Transform {
  constructor(key) {
    super();
    this.key = key;
    this.prefix = crypto.randomBytes(8);
    this.counter = 0;
  }

  _transform(chunk, encoding, callback) {
    try {
      const plain = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
      if (plain.length === 0) {
        callback();
        return;
      }

      if (this.counter > 0xffffffff) {
        throw new Error('Too many encrypted frames for one transfer');
      }

      const iv = Buffer.alloc(12);
      this.prefix.copy(iv, 0);
      iv.writeUInt32BE(this.counter, 8);
      this.counter += 1;

      const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
      const encrypted = cipher.update(plain);
      cipher.final();
      const tag = cipher.getAuthTag();
      const length = Buffer.alloc(4);
      length.writeUInt32BE(encrypted.length, 0);

      const frame = Buffer.allocUnsafe(FRAME_HEADER_BYTES + encrypted.length);
      length.copy(frame, 0);
      iv.copy(frame, 4);
      tag.copy(frame, 16);
      encrypted.copy(frame, FRAME_HEADER_BYTES);
      this.push(frame);
      callback();
    } catch (error) {
      callback(error);
    }
  }
}

class DecryptFrameStream extends Transform {
  constructor(key) {
    super();
    this.key = key;
    this.chunks = [];
    this.bufferedBytes = 0;
  }

  _transform(chunk, encoding, callback) {
    try {
      const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
      if (next.length > 0) {
        this.chunks.push(next);
        this.bufferedBytes += next.length;
      }
      this._drainFrames();
      callback();
    } catch (error) {
      callback(error);
    }
  }

  _flush(callback) {
    try {
      if (this.bufferedBytes !== 0) {
        throw new Error('Encrypted stream ended with an incomplete frame');
      }
      callback();
    } catch (error) {
      callback(error);
    }
  }

  _drainFrames() {
    while (this.bufferedBytes >= FRAME_HEADER_BYTES) {
      const encryptedLength = this._peekUInt32BE();
      if (encryptedLength > MAX_FRAME_BYTES) {
        throw new Error('Encrypted frame is too large');
      }

      const frameLength = FRAME_HEADER_BYTES + encryptedLength;
      if (this.bufferedBytes < frameLength) {
        return;
      }

      this._readBytes(4);
      const iv = this._readBytes(12);
      const tag = this._readBytes(16);
      const encrypted = this._readBytes(encryptedLength);
      const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, iv);
      decipher.setAuthTag(tag);
      const plain = decipher.update(encrypted);
      decipher.final();
      this.push(plain);
    }
  }

  _peekUInt32BE() {
    const first = this.chunks[0];
    if (first.length >= 4) {
      return first.readUInt32BE(0);
    }

    const header = Buffer.allocUnsafe(4);
    let copied = 0;
    for (const chunk of this.chunks) {
      const toCopy = Math.min(chunk.length, 4 - copied);
      chunk.copy(header, copied, 0, toCopy);
      copied += toCopy;
      if (copied === 4) {
        return header.readUInt32BE(0);
      }
    }

    throw new Error('Encrypted stream ended with an incomplete frame');
  }

  _readBytes(length) {
    if (length === 0) {
      return Buffer.alloc(0);
    }

    this.bufferedBytes -= length;
    const first = this.chunks[0];
    if (first.length === length) {
      this.chunks.shift();
      return first;
    }
    if (first.length > length) {
      this.chunks[0] = first.subarray(length);
      return first.subarray(0, length);
    }

    const result = Buffer.allocUnsafe(length);
    let offset = 0;
    while (offset < length) {
      const chunk = this.chunks[0];
      const toCopy = Math.min(chunk.length, length - offset);
      chunk.copy(result, offset, 0, toCopy);
      offset += toCopy;
      if (toCopy === chunk.length) {
        this.chunks.shift();
      } else {
        this.chunks[0] = chunk.subarray(toCopy);
      }
    }
    return result;
  }
}

module.exports = {
  createKeyPair,
  createX25519KeyPair,
  deriveTransferKey,
  fingerprintFor,
  signTransferRequest,
  verifyTransferRequest,
  sha256File,
  EncryptFrameStream,
  DecryptFrameStream
};

const dgram = require('dgram');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { fingerprintFor } = require('./crypto');

const APP_ID = 'nearby-transfer';
const PROTOCOL_VERSION = 1;
const MULTICAST_ADDRESS = '239.255.77.77';
const DISCOVERY_PORT = 47777;
const ANNOUNCE_INTERVAL_MS = 2000;
const PEER_TTL_MS = 10000;
const MAX_ANNOUNCEMENT_BYTES = 16 * 1024;
const MAX_DEVICE_NAME_LENGTH = 128;
const MAX_PUBLIC_KEY_LENGTH = 4096;

class Discovery extends EventEmitter {
  constructor(options) {
    super();
    this.device = options.device;
    this.port = options.port;
    this.socket = null;
    this.peers = new Map();
    this.announceTimer = null;
    this.pruneTimer = null;
  }

  start() {
    if (this.socket) {
      return;
    }

    this.socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.socket.on('message', (message, remote) => this._handleMessage(message, remote));
    this.socket.on('error', (error) => this.emit('error', error));
    this.socket.bind(DISCOVERY_PORT, () => {
      try {
        this.socket.addMembership(MULTICAST_ADDRESS);
        this.socket.setMulticastTTL(1);
        this.socket.setMulticastLoopback(true);
      } catch (error) {
        this.emit('error', error);
      }

      this.announce();
      this.announceTimer = setInterval(() => this.announce(), ANNOUNCE_INTERVAL_MS);
      this.pruneTimer = setInterval(() => this._prunePeers(), ANNOUNCE_INTERVAL_MS);
    });
  }

  stop() {
    if (this.announceTimer) {
      clearInterval(this.announceTimer);
      this.announceTimer = null;
    }
    if (this.pruneTimer) {
      clearInterval(this.pruneTimer);
      this.pruneTimer = null;
    }
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
  }

  announce() {
    if (!this.socket) {
      return;
    }

    const payload = Buffer.from(JSON.stringify({
      app: APP_ID,
      protocolVersion: PROTOCOL_VERSION,
      type: 'announce',
      deviceId: this.device.deviceId,
      deviceName: this.device.deviceName,
      port: this.port,
      signingPublicKey: this.device.signingPublicKey,
      encryptionPublicKey: this.device.encryptionPublicKey,
      fingerprint: this.device.fingerprint,
      timestamp: Date.now()
    }));

    this.socket.send(payload, 0, payload.length, DISCOVERY_PORT, MULTICAST_ADDRESS);
  }

  listPeers() {
    return Array.from(this.peers.values()).sort((a, b) => a.deviceName.localeCompare(b.deviceName));
  }

  getPeer(deviceId) {
    return this.peers.get(deviceId);
  }

  _handleMessage(message, remote) {
    if (!Buffer.isBuffer(message) || message.length > MAX_ANNOUNCEMENT_BYTES) {
      return;
    }

    let payload;
    try {
      payload = JSON.parse(message.toString('utf8'));
    } catch (_error) {
      return;
    }

    if (!isValidAnnouncement(payload, this.device.deviceId)) {
      return;
    }

    const peer = {
      deviceId: payload.deviceId,
      deviceName: payload.deviceName,
      host: remote.address,
      port: payload.port,
      signingPublicKey: payload.signingPublicKey,
      encryptionPublicKey: payload.encryptionPublicKey,
      fingerprint: payload.fingerprint,
      lastSeen: Date.now()
    };
    this.peers.set(peer.deviceId, peer);
    this.emit('peer', peer);
    this.emit('peers', this.listPeers());
  }

  _prunePeers() {
    const now = Date.now();
    let changed = false;
    for (const [deviceId, peer] of this.peers.entries()) {
      if (now - peer.lastSeen > PEER_TTL_MS) {
        this.peers.delete(deviceId);
        changed = true;
      }
    }
    if (changed) {
      this.emit('peers', this.listPeers());
    }
  }
}

function isValidAnnouncement(payload, localDeviceId) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return false;
  }
  if (payload.app !== APP_ID || payload.protocolVersion !== PROTOCOL_VERSION || payload.type !== 'announce') {
    return false;
  }
  if (payload.deviceId === localDeviceId) {
    return false;
  }
  if (!/^[a-f0-9]{16}$/.test(payload.deviceId) ||
    !isNonEmptyBoundedString(payload.deviceName, MAX_DEVICE_NAME_LENGTH) ||
    !isValidPort(payload.port) ||
    !isNonEmptyBoundedString(payload.signingPublicKey, MAX_PUBLIC_KEY_LENGTH) ||
    !isNonEmptyBoundedString(payload.encryptionPublicKey, MAX_PUBLIC_KEY_LENGTH) ||
    !isNonEmptyBoundedString(payload.fingerprint, 64)) {
    return false;
  }
  return isIdentityConsistent(payload) && hasExpectedKeyTypes(payload);
}

function isNonEmptyBoundedString(value, maxLength) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength;
}

function isValidPort(port) {
  return Number.isSafeInteger(port) && port >= 1 && port <= 65535;
}

function isIdentityConsistent(payload) {
  try {
    const expectedDeviceId = crypto.createHash('sha256')
      .update(payload.signingPublicKey)
      .digest('hex')
      .slice(0, 16);
    return payload.deviceId === expectedDeviceId && payload.fingerprint === fingerprintFor(payload.signingPublicKey);
  } catch (_error) {
    return false;
  }
}

function hasExpectedKeyTypes(payload) {
  try {
    const signingKey = crypto.createPublicKey(payload.signingPublicKey);
    const encryptionKey = crypto.createPublicKey(payload.encryptionPublicKey);
    return signingKey.asymmetricKeyType === 'ed25519' && encryptionKey.asymmetricKeyType === 'x25519';
  } catch (_error) {
    return false;
  }
}

module.exports = {
  Discovery,
  DISCOVERY_PORT
};

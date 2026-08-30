const dgram = require('dgram');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { fingerprintFor, signDiscoveryAnnouncement, verifyDiscoveryAnnouncement } = require('./crypto');
const { multicastInterfaces } = require('./multicast-interfaces');

const APP_ID = 'nearby-transfer';
// Signed classic discovery is a wire-incompatible successor to the original
// unsigned announcement. Keep its version distinct so mixed installations do
// not silently interpret two different envelopes as the same protocol.
const PROTOCOL_VERSION = 2;
const MULTICAST_ADDRESS = '239.255.77.77';
const DISCOVERY_PORT = 47777;
const ANNOUNCE_INTERVAL_MS = 2000;
const PEER_TTL_MS = 10000;
const MAX_ANNOUNCEMENT_BYTES = 16 * 1024;
const MAX_DEVICE_NAME_LENGTH = 128;
const MAX_PUBLIC_KEY_LENGTH = 4096;
const MAX_CLOCK_SKEW_MS = 30 * 1000;

class Discovery extends EventEmitter {
  constructor(options) {
    super();
    this.device = options.device;
    this.port = options.port;
    this.socket = null;
    this.peers = new Map();
    this.announceTimer = null;
    this.pruneTimer = null;
    this.multicastInterfaces = [];
  }

  start() {
    if (this.socket) {
      return;
    }

    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.socket = socket;
    socket.on('message', (message, remote) => this._handleMessage(message, remote));
    socket.on('error', (error) => {
      if (this.socket === socket) {
        this._clearTimers();
        this.socket = null;
        this.multicastInterfaces = [];
      }
      this.emit('error', error);
    });
    socket.bind(DISCOVERY_PORT, () => {
      if (this.socket !== socket) {
        try { socket.close(); } catch (_) {}
        return;
      }
      this._configureMulticast();

      this.announce();
      this.announceTimer = setInterval(() => this.announce(), ANNOUNCE_INTERVAL_MS);
      this.pruneTimer = setInterval(() => this._prunePeers(), ANNOUNCE_INTERVAL_MS);
    });
  }

  stop() {
    this._clearTimers();
    const socket = this.socket;
    if (socket) {
      this.socket = null;
      this.multicastInterfaces = [];
      try { socket.close(); } catch (_) {}
    }
  }

  _clearTimers() {
    if (this.announceTimer) {
      clearInterval(this.announceTimer);
      this.announceTimer = null;
    }
    if (this.pruneTimer) {
      clearInterval(this.pruneTimer);
      this.pruneTimer = null;
    }
  }

  _checkAndReconfigureInterfaces() {
    const currentList = multicastInterfaces();
    const joinedSet = new Set(this.multicastInterfaces);
    const isDifferent = currentList.length !== this.multicastInterfaces.length || currentList.some(ip => !joinedSet.has(ip));
    if (isDifferent) {
      this._configureMulticast();
    }
  }

  announce() {
    if (!this.socket) {
      return;
    }
    this._checkAndReconfigureInterfaces();

    const announcement = {
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
    };
    const payload = Buffer.from(JSON.stringify(Object.assign({}, announcement, {
      signature: signDiscoveryAnnouncement(announcement, this.device.signingPrivateKey)
    })));

    const interfaces = this.multicastInterfaces;
    if (interfaces.length === 0) {
      this.socket.send(payload, 0, payload.length, DISCOVERY_PORT, MULTICAST_ADDRESS);
      return;
    }
    for (const interfaceAddress of interfaces) {
      try {
        this.socket.setMulticastInterface(interfaceAddress);
        this.socket.send(payload, 0, payload.length, DISCOVERY_PORT, MULTICAST_ADDRESS);
      } catch (error) {
        this.emit('error', error);
      }
    }
  }

  _configureMulticast() {
    const socket = this.socket;
    if (!socket) return;
    socket.setMulticastTTL(1);
    socket.setMulticastLoopback(true);
    const joined = [];
    for (const interfaceAddress of multicastInterfaces()) {
      try {
        socket.addMembership(MULTICAST_ADDRESS, interfaceAddress);
        joined.push(interfaceAddress);
      } catch (error) {
        this.emit('error', error);
      }
    }
    if (joined.length === 0) {
      try {
        socket.addMembership(MULTICAST_ADDRESS);
      } catch (error) {
        this.emit('error', error);
      }
    }
    this.multicastInterfaces = joined;
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
  if (!Number.isSafeInteger(payload.timestamp) || Math.abs(Date.now() - payload.timestamp) > MAX_CLOCK_SKEW_MS) {
    return false;
  }
  return isIdentityConsistent(payload) &&
    hasExpectedKeyTypes(payload) &&
    verifyDiscoveryAnnouncement(payload, payload.signature, payload.signingPublicKey);
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

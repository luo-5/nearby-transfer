'use strict';

const crypto = require('crypto');
const dgram = require('dgram');
const { EventEmitter } = require('events');
const { TextDecoder } = require('util');
const { APP_ID, MESSAGE_TYPES, MAX_CAPABILITIES, MAX_CAPABILITY_LENGTH, MAX_DEVICE_NAME_LENGTH, PROTOCOL_VERSION } = require('./constants');
const { canonicalJson, parseCanonicalJson } = require('./canonical-json');
const { multicastInterfaces } = require('../core/multicast-interfaces');
const { assertValidPublicIdentity, publicIdentity } = require('./pairing');

const MULTICAST_ADDRESS = '239.255.77.77';
const DISCOVERY_PORT = 47777;
const ANNOUNCE_INTERVAL_MS = 2000;
const PEER_TTL_MS = 10000;
const MAX_ANNOUNCEMENT_BYTES = 16 * 1024;
const MAX_CLOCK_SKEW_MS = 30 * 1000;
const CAPABILITY_PATTERN = /^[a-z][a-z0-9-]*$/;
const utf8Decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

class V2Discovery extends EventEmitter {
  constructor({ device, port, capabilities = [], announceIntervalMs = ANNOUNCE_INTERVAL_MS, peerTtlMs = PEER_TTL_MS }) {
    super();
    assertValidPublicIdentity(device);
    assertPort(port);
    this.device = device;
    this.port = port;
    this.capabilities = normalizeCapabilities(capabilities);
    this.announceIntervalMs = positiveInteger(announceIntervalMs, 'announceIntervalMs');
    this.peerTtlMs = positiveInteger(peerTtlMs, 'peerTtlMs');
    this.socket = null;
    this.peers = new Map();
    this.announceTimer = null;
    this.pruneTimer = null;
    this.multicastInterfaces = [];
  }

  start() {
    if (this.socket) return;
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.socket = socket;
    socket.on('message', (message, remote) => this._handleMessage(message, remote));
    socket.on('error', (error) => this.emit('error', error));
    socket.bind(DISCOVERY_PORT, () => {
      if (socket !== this.socket) return;
      this._configureMulticast(socket);
      this.announce();
      this.announceTimer = setInterval(() => this.announce(), this.announceIntervalMs);
      this.pruneTimer = setInterval(() => this._prunePeers(), this.announceIntervalMs);
    });
  }

  stop() {
    if (this.announceTimer) clearInterval(this.announceTimer);
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    this.announceTimer = null;
    this.pruneTimer = null;
    if (this.socket) this.socket.close();
    this.socket = null;
    this.multicastInterfaces = [];
    this.peers.clear();
  }

  announce(now = Date.now()) {
    if (!this.socket) return;
    try {
      const announcement = createDiscoveryAnnouncement({
        device: this.device,
        port: this.port,
        capabilities: this.capabilities,
        issuedAt: now
      });
      const encoded = Buffer.from(canonicalJson({
        ...announcement,
        signature: signDiscoveryAnnouncement(announcement, this.device.signingPrivateKey)
      }), 'utf8');
      const interfaces = this.multicastInterfaces;
      if (interfaces.length === 0) {
        this.socket.send(encoded, 0, encoded.length, DISCOVERY_PORT, MULTICAST_ADDRESS);
        return;
      }
      for (const interfaceAddress of interfaces) {
        try {
          this.socket.setMulticastInterface(interfaceAddress);
          this.socket.send(encoded, 0, encoded.length, DISCOVERY_PORT, MULTICAST_ADDRESS);
        } catch (error) {
          this.emit('error', error);
        }
      }
    } catch (error) {
      this.emit('error', error);
    }
  }

  _configureMulticast(socket) {
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
    return Array.from(this.peers.values()).sort((left, right) => left.deviceName.localeCompare(right.deviceName));
  }

  getPeer(deviceId) {
    return this.peers.get(deviceId) || null;
  }

  _handleMessage(message, remote, now = Date.now()) {
    let announcement;
    try {
      announcement = parseDiscoveryDatagram(message);
      assertFreshDiscoveryAnnouncement(announcement, now);
      if (announcement.identity.deviceId === this.device.deviceId || !verifyDiscoveryAnnouncement(announcement, announcement.signature)) return;
    } catch (_error) {
      return;
    }

    const nextPeer = {
      deviceId: announcement.identity.deviceId,
      deviceName: announcement.identity.deviceName,
      fingerprint: announcement.identity.fingerprint,
      signingPublicKey: announcement.identity.signingPublicKey,
      encryptionPublicKey: announcement.identity.encryptionPublicKey,
      host: remote.address,
      port: announcement.port,
      capabilities: announcement.capabilities,
      lastSeen: now
    };
    const previous = this.peers.get(nextPeer.deviceId);
    this.peers.set(nextPeer.deviceId, nextPeer);
    if (!previous || !samePeerEndpoint(previous, nextPeer)) {
      this.emit('peer', nextPeer);
      this.emit('peers', this.listPeers());
    }
  }

  _prunePeers(now = Date.now()) {
    let changed = false;
    for (const [deviceId, peer] of this.peers) {
      if (now - peer.lastSeen > this.peerTtlMs) {
        this.peers.delete(deviceId);
        changed = true;
      }
    }
    if (changed) this.emit('peers', this.listPeers());
  }
}

function createDiscoveryAnnouncement({ device, port, capabilities = [], issuedAt = Date.now() }) {
  const announcement = {
    app: APP_ID,
    protocolVersion: PROTOCOL_VERSION,
    type: MESSAGE_TYPES.DISCOVERY_ANNOUNCE,
    issuedAt,
    identity: publicIdentity(device),
    port,
    capabilities: normalizeCapabilities(capabilities)
  };
  assertValidDiscoveryAnnouncement(announcement);
  return announcement;
}

function discoveryAnnouncementSigningPayload(announcement) {
  assertValidDiscoveryAnnouncement(announcement);
  return canonicalJson({
    app: announcement.app,
    protocolVersion: announcement.protocolVersion,
    type: announcement.type,
    issuedAt: announcement.issuedAt,
    identity: publicIdentity(announcement.identity),
    port: announcement.port,
    capabilities: normalizeCapabilities(announcement.capabilities)
  });
}

function signDiscoveryAnnouncement(announcement, privateKeyPem) {
  return crypto.sign(null, Buffer.from(discoveryAnnouncementSigningPayload(announcement), 'utf8'), crypto.createPrivateKey(privateKeyPem)).toString('base64');
}

function verifyDiscoveryAnnouncement(announcement, signature) {
  try {
    assertValidDiscoveryAnnouncement(announcement);
    if (typeof signature !== 'string' || signature.length === 0 || signature.length > 512) return false;
    return crypto.verify(
      null,
      Buffer.from(discoveryAnnouncementSigningPayload(announcement), 'utf8'),
      crypto.createPublicKey(announcement.identity.signingPublicKey),
      Buffer.from(signature, 'base64')
    );
  } catch (_error) {
    return false;
  }
}

function parseDiscoveryDatagram(message) {
  if (!Buffer.isBuffer(message) || message.length === 0 || message.length > MAX_ANNOUNCEMENT_BYTES) {
    throw new RangeError('Discovery datagram exceeds the accepted bounds');
  }
  const serialized = utf8Decoder.decode(message);
  const parsed = parseCanonicalJson(serialized, 'Discovery announcement');
  assertExactKeys(parsed, ['app', 'protocolVersion', 'type', 'issuedAt', 'identity', 'port', 'capabilities', 'signature'], 'Discovery announcement');
  assertValidDiscoveryAnnouncement(parsed);
  if (typeof parsed.signature !== 'string' || parsed.signature.length === 0 || parsed.signature.length > 512) {
    throw new TypeError('Discovery announcement signature is invalid');
  }
  return parsed;
}

function assertValidDiscoveryAnnouncement(announcement) {
  assertPlainObject(announcement, 'Discovery announcement');
  assertExactKeys(announcement, ['app', 'protocolVersion', 'type', 'issuedAt', 'identity', 'port', 'capabilities'], 'Discovery announcement', ['signature']);
  if (announcement.app !== APP_ID || announcement.protocolVersion !== PROTOCOL_VERSION || announcement.type !== MESSAGE_TYPES.DISCOVERY_ANNOUNCE) {
    throw new TypeError('Discovery announcement has an unsupported protocol envelope');
  }
  if (!Number.isSafeInteger(announcement.issuedAt) || announcement.issuedAt <= 0) {
    throw new TypeError('Discovery announcement issue time is invalid');
  }
  assertValidPublicIdentity(announcement.identity);
  assertPort(announcement.port);
  normalizeCapabilities(announcement.capabilities);
  return announcement;
}

function assertFreshDiscoveryAnnouncement(announcement, now = Date.now()) {
  assertValidDiscoveryAnnouncement(announcement);
  if (!Number.isSafeInteger(now) || now <= 0 || Math.abs(now - announcement.issuedAt) > MAX_CLOCK_SKEW_MS) {
    throw new Error('Discovery announcement is stale or has an invalid clock');
  }
}

function normalizeCapabilities(capabilities) {
  if (!Array.isArray(capabilities) || capabilities.length > MAX_CAPABILITIES) throw new TypeError('Discovery capabilities must be a bounded array');
  const normalized = capabilities.map((capability) => {
    if (typeof capability !== 'string' || capability.length === 0 || capability.length > MAX_CAPABILITY_LENGTH || !CAPABILITY_PATTERN.test(capability)) {
      throw new TypeError('Discovery capability is invalid');
    }
    return capability;
  });
  if (new Set(normalized).size !== normalized.length) throw new TypeError('Discovery capabilities must not contain duplicates');
  return normalized.slice().sort();
}

function assertPort(port) {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new TypeError('Discovery port is invalid');
}

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive integer`);
  return value;
}

function samePeerEndpoint(left, right) {
  return left.deviceName === right.deviceName && left.host === right.host && left.port === right.port &&
    left.fingerprint === right.fingerprint && canonicalJson(left.capabilities) === canonicalJson(right.capabilities);
}

function assertPlainObject(value, name) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new TypeError(`${name} must be a plain object`);
  }
}

function assertExactKeys(value, required, name, optional = []) {
  const allowed = new Set([...required, ...optional]);
  for (const key of required) if (!Object.hasOwn(value, key)) throw new TypeError(`${name} is missing ${key}`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`${name} contains unknown field ${key}`);
}

module.exports = {
  V2Discovery,
  DISCOVERY_PORT,
  createDiscoveryAnnouncement,
  discoveryAnnouncementSigningPayload,
  signDiscoveryAnnouncement,
  verifyDiscoveryAnnouncement,
  parseDiscoveryDatagram,
  assertValidDiscoveryAnnouncement,
  assertFreshDiscoveryAnnouncement
};
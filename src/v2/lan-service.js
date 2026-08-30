'use strict';

const net = require('net');
const { EventEmitter } = require('events');
const { MESSAGE_TYPES, PROTOCOL_VERSION, APP_ID } = require('./constants');
const { V2Discovery } = require('./discovery');
const { encodeWireFrame, WireFrameDecoder } = require('./wire-frame');
const { encodeControlMessage } = require('./message-codec');
const { createPairingCancel, signPairingCancel } = require('./pairing');
const { PairingRouter } = require('./pairing-router');
const { PAIRING_SESSION_TTL_MS } = require('./pairing-session-store');

const DEFAULT_MAX_CONNECTIONS = 16;
const DEFAULT_MAX_CONNECTIONS_PER_IP = 4;
const DEFAULT_BOOTSTRAP_TIMEOUT_MS = 10 * 1000;
const DEFAULT_MAX_BOOTSTRAP_BYTES = 32 * 1024;
const DEFAULT_MAX_BOOTSTRAP_FRAMES = 8;

class LanService extends EventEmitter {
  constructor({
    device,
    pairingApi,
    capabilities = ['pairing'],
    maxConnections = DEFAULT_MAX_CONNECTIONS,
    maxConnectionsPerIp = DEFAULT_MAX_CONNECTIONS_PER_IP,
    bootstrapTimeoutMs = DEFAULT_BOOTSTRAP_TIMEOUT_MS,
    maxBootstrapBytes = DEFAULT_MAX_BOOTSTRAP_BYTES,
    maxBootstrapFrames = DEFAULT_MAX_BOOTSTRAP_FRAMES,
    enableDiscovery = true
  }) {
    super();
    if (!device || typeof device.signingPrivateKey !== 'string') throw new TypeError('A signing-capable local device is required');
    if (!pairingApi || typeof pairingApi.startPairing !== 'function' || typeof pairingApi.createLocalConfirmation !== 'function' ||
        typeof pairingApi.createResponderOffer !== 'function' || typeof pairingApi.getPairingSession !== 'function' || typeof pairingApi.complete !== 'function') {
      throw new TypeError('A complete pairing API is required');
    }
    this.device = device;
    this.pairingApi = pairingApi;
    this.capabilities = normalizeCapabilities(capabilities);
    this.maxConnections = positiveInteger(maxConnections, 'maxConnections');
    this.maxConnectionsPerIp = positiveInteger(maxConnectionsPerIp, 'maxConnectionsPerIp');
    this.bootstrapTimeoutMs = positiveInteger(bootstrapTimeoutMs, 'bootstrapTimeoutMs');
    this.maxBootstrapBytes = positiveInteger(maxBootstrapBytes, 'maxBootstrapBytes');
    this.maxBootstrapFrames = positiveInteger(maxBootstrapFrames, 'maxBootstrapFrames');
    this.enableDiscovery = enableDiscovery === true;
    this.router = new PairingRouter({ pairingApi });
    this.server = null;
    this.port = null;
    this.startPromise = null;
    this.stopPromise = null;
    this.discovery = null;
    this.connections = new Set();
    this.connectionsByPairingId = new Map();
    this.connectionsPerIp = new Map();
  }

  async start(port = 0) {
    if (this.stopPromise) await this.stopPromise;
    if (this.server && this.server.listening && this.port !== null) return this.port;
    if (this.startPromise) return this.startPromise;
    const operation = (async () => {
      const server = net.createServer((socket) => this._acceptSocket(socket));
      server.maxConnections = this.maxConnections;
      this.server = server;
      try {
        await new Promise((resolve, reject) => {
          const onError = (error) => { server.off('listening', onListening); reject(error); };
          const onListening = () => { server.off('error', onError); resolve(); };
          server.once('error', onError);
          server.once('listening', onListening);
          server.listen(port, '0.0.0.0');
        });
        this.port = server.address().port;
        if (this.enableDiscovery) {
          this.discovery = new V2Discovery({ device: this.device, port: this.port, capabilities: this.capabilities });
          this.discovery.on('peer', (peer) => this.emit('peer', peer));
          this.discovery.on('peers', (peers) => this.emit('peers', peers));
          this.discovery.on('error', (error) => this.emit('error', error));
          this.discovery.start();
        }
        return this.port;
      } catch (error) {
        if (this.discovery) this.discovery.stop();
        this.discovery = null;
        if (this.server === server) this.server = null;
        this.port = null;
        await new Promise((resolve) => server.close(() => resolve()));
        server.unref();
        throw error;
      }
    })();
    this.startPromise = operation;
    try { return await operation; } finally { if (this.startPromise === operation) this.startPromise = null; }
  }

  async stop() {
    if (this.stopPromise) return this.stopPromise;
    const operation = (async () => {
      if (this.startPromise) { try { await this.startPromise; } catch (_error) {} }
      if (this.discovery) this.discovery.stop();
      this.discovery = null;
      for (const connection of Array.from(this.connections)) connection.socket.destroy();
      this.connections.clear();
      this.connectionsByPairingId.clear();
      this.connectionsPerIp.clear();
      const server = this.server;
      this.server = null;
      this.port = null;
      if (server) await new Promise((resolve) => server.close(() => resolve()));
    })();
    this.stopPromise = operation;
    try { await operation; } finally { if (this.stopPromise === operation) this.stopPromise = null; }
  }

  listPeers() {
    return this.discovery ? this.discovery.listPeers() : [];
  }

  async startPairing(peer, { capabilities = this.capabilities } = {}) {
    assertPeerEndpoint(peer);
    const started = this.pairingApi.startPairing({ capabilities });
    const connection = await this._connect(peer.host, peer.port, peer.deviceId);
    connection.binding.pairingId = started.session.pairingId;
    this.connectionsByPairingId.set(started.session.pairingId, connection);
    this._sendControl(connection, MESSAGE_TYPES.PAIRING_OFFER, started.outboundOffer);
    this._activatePairingDeadline(connection);
    return this._requireSession(started.session.pairingId);
  }

  confirmPairing(pairingId, { capabilities = this.capabilities } = {}) {
    const connection = this._requireConnection(pairingId);
    const session = this._requireSession(pairingId);
    if (session.role === 'responder') {
      const responderOffer = this.pairingApi.createResponderOffer(pairingId, { capabilities });
      this._sendControl(connection, MESSAGE_TYPES.PAIRING_OFFER, { offer: responderOffer.offer, signature: responderOffer.signature });
      this._activatePairingDeadline(connection);
    }
    const confirmation = this.pairingApi.createLocalConfirmation(pairingId);
    this._sendControl(connection, MESSAGE_TYPES.PAIRING_CONFIRM, { confirmation: confirmation.confirmation, signature: confirmation.signature });
    this._emitSession(pairingId);
    return this._requireSession(pairingId);
  }

  completePairing(pairingId, options) {
    const peer = this.pairingApi.complete(pairingId, options);
    this._emitSession(pairingId);
    return peer;
  }

  cancelPairing(pairingId, reason = 'user-cancelled') {
    const connection = this.connectionsByPairingId.get(pairingId);
    const session = this._requireSession(pairingId);
    if (connection && !connection.socket.destroyed && connection.binding.remoteDeviceId) {
      const cancellation = createPairingCancel({ pairingId, device: this.device, reason });
      this._sendControl(connection, MESSAGE_TYPES.PAIRING_CANCEL, {
        cancellation,
        signature: signPairingCancel(cancellation, this.device.signingPrivateKey)
      });
    }
    const result = this.pairingApi.cancel(pairingId, reason);
    this._emitSession(pairingId);
    return result;
  }

  _acceptSocket(socket) {
    if (this.connections.size >= this.maxConnections) return socket.destroy();
    const remoteAddress = socket.remoteAddress || 'unknown';
    if ((this.connectionsPerIp.get(remoteAddress) || 0) >= this.maxConnectionsPerIp) return socket.destroy();
    this._registerSocket(socket, { outbound: false });
  }

  _connect(host, port, expectedDeviceId) {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host, port });
      const onError = (error) => { socket.off('connect', onConnect); reject(error); };
      const onConnect = () => {
        socket.off('error', onError);
        try {
          resolve(this._registerSocket(socket, { outbound: true, expectedDeviceId }));
        } catch (error) {
          socket.destroy();
          reject(error);
        }
      };
      socket.once('error', onError);
      socket.once('connect', onConnect);
    });
  }

  _registerSocket(socket, { outbound, expectedDeviceId = null }) {
    if (this.connections.size >= this.maxConnections) throw new Error('Too many pairing connections');
    const remoteAddress = socket.remoteAddress || 'unknown';
    const count = this.connectionsPerIp.get(remoteAddress) || 0;
    if (count >= this.maxConnectionsPerIp) throw new Error('Too many pairing connections from this address');
    const connection = {
      socket,
      outbound,
      remoteAddress,
      decoder: new WireFrameDecoder(),
      inputBytes: 0,
      frameCount: 0,
      binding: { expectedDeviceId, pairingId: null, remoteDeviceId: null },
      pairingDeadlineActive: false
    };
    this.connections.add(connection);
    this.connectionsPerIp.set(remoteAddress, count + 1);
    socket.setNoDelay(true);
    socket.setTimeout(this.bootstrapTimeoutMs, () => socket.destroy());
    socket.on('data', (chunk) => this._onData(connection, chunk));
    socket.on('error', (error) => this.emit('connection-error', { remoteAddress, error }));
    socket.on('close', () => this._closeConnection(connection));
    return connection;
  }

  _onData(connection, chunk) {
    try {
      connection.inputBytes += chunk.length;
      if (connection.inputBytes > this.maxBootstrapBytes) throw new RangeError('Pairing bootstrap input exceeds the accepted limit');
      const frames = connection.decoder.push(chunk);
      for (const frame of frames) {
        connection.frameCount += 1;
        if (connection.frameCount > this.maxBootstrapFrames) throw new RangeError('Pairing bootstrap frame count exceeds the accepted limit');
        const result = this.router.receiveFrame(frame, connection.binding);
        if (result.kind === 'offer') this._activatePairingDeadline(connection);
        if (connection.binding.pairingId) this.connectionsByPairingId.set(connection.binding.pairingId, connection);
        if (result.kind === 'cancellation') connection.socket.end();
        this._emitSession(connection.binding.pairingId);
      }
    } catch (error) {
      this.emit('protocol-error', { remoteAddress: connection.remoteAddress, error });
      connection.socket.destroy();
    }
  }

  _activatePairingDeadline(connection) {
    if (!connection || connection.pairingDeadlineActive || connection.socket.destroyed) return;
    // Before a verified offer, short idle timeouts constrain unauthenticated sockets. Once
    // either side accepts an offer, keep the same connection for the full SAS comparison
    // window so a human can safely verify the code without racing a 10-second timeout.
    connection.socket.setTimeout(PAIRING_SESSION_TTL_MS);
    connection.pairingDeadlineActive = true;
  }

  _sendControl(connection, type, message) {
    if (!connection || connection.socket.destroyed) throw new Error('Pairing connection is unavailable');
    const frame = encodeWireFrame({
      header: { app: APP_ID, protocolVersion: PROTOCOL_VERSION, type },
      payload: encodeControlMessage(type, message)
    });
    if (frame.length > this.maxBootstrapBytes) throw new RangeError('Pairing control frame exceeds the accepted limit');
    connection.socket.write(frame);
  }

  _requireConnection(pairingId) {
    const connection = this.connectionsByPairingId.get(pairingId);
    if (!connection || connection.socket.destroyed) throw new Error('Pairing connection is unavailable');
    return connection;
  }

  _requireSession(pairingId) {
    // LAN service methods are consumed by the Electron IPC adapter, which owns
    // the public/redacted representation. Keep the service on the internal
    // session shape so its return values can be safely converted exactly once.
    const session = this.pairingApi.getPairingSession(pairingId);
    if (!session) throw new Error('Pairing session is not active');
    return session;
  }

  _emitSession(pairingId) {
    if (!pairingId) return;
    const session = this.pairingApi.listPairingSessions().find((item) => item.pairingId === pairingId) || null;
    this.emit('pairing-session', session);
  }

  _closeConnection(connection) {
    if (!this.connections.delete(connection)) return;
    const count = this.connectionsPerIp.get(connection.remoteAddress) || 0;
    if (count <= 1) this.connectionsPerIp.delete(connection.remoteAddress);
    else this.connectionsPerIp.set(connection.remoteAddress, count - 1);
    if (connection.binding.pairingId && this.connectionsByPairingId.get(connection.binding.pairingId) === connection) {
      this.connectionsByPairingId.delete(connection.binding.pairingId);
    }
    try { connection.decoder.finish(); } catch (_error) { /* socket already failed or truncated */ }
  }
}

function assertPeerEndpoint(peer) {
  if (!peer || typeof peer !== 'object' || typeof peer.host !== 'string' || peer.host.length === 0 ||
      !Number.isSafeInteger(peer.port) || peer.port < 1 || peer.port > 65535 ||
      !/^[a-f0-9]{16}$/.test(peer.deviceId || '')) {
    throw new TypeError('A valid v2 discovery peer endpoint is required');
  }
}

function normalizeCapabilities(capabilities) {
  if (!Array.isArray(capabilities)) throw new TypeError('Capabilities must be an array');
  return capabilities.slice();
}

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive integer`);
  return value;
}

module.exports = {
  LanService,
  DEFAULT_MAX_CONNECTIONS,
  DEFAULT_MAX_CONNECTIONS_PER_IP,
  DEFAULT_BOOTSTRAP_TIMEOUT_MS,
  DEFAULT_MAX_BOOTSTRAP_BYTES,
  DEFAULT_MAX_BOOTSTRAP_FRAMES
};

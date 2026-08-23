/**
 * v2 TCP LAN service: accepts incoming connections, handles pairing handshake,
 * and manages connection lifecycle. Ported from src/v2/lan-service.js.
 *
 * Runs a TCP server that accepts pairing connections, decodes wire frames,
 * routes them through the PairingRouter, and emits pairing-session events.
 * Optionally starts a V2Discovery announcer so peers can find this device.
 */

import net from 'node:net';
import { EventEmitter } from 'node:events';
import { APP_ID, PROTOCOL_VERSION, MESSAGE_TYPES } from '../constants.js';
import { V2Discovery, type DiscoveredPeerEntry } from '../discovery/index.js';
import { encodeWireFrame, WireFrameDecoder, type WireFrame } from '../transfer/wire-frame.js';
import { encodeControlMessage } from '../pairing/message-codec.js';
import { createPairingCancel, signPairingCancel, type PairingDevice } from '../pairing/sas.js';
import { PairingRouter, type PairingApi, type ConnectionBinding } from '../pairing/router.js';

export const DEFAULT_MAX_CONNECTIONS = 16;
export const DEFAULT_MAX_CONNECTIONS_PER_IP = 4;
export const DEFAULT_BOOTSTRAP_TIMEOUT_MS = 10 * 1000;
export const DEFAULT_MAX_BOOTSTRAP_BYTES = 32 * 1024;
export const DEFAULT_MAX_BOOTSTRAP_FRAMES = 8;
export const PAIRING_SESSION_TTL_MS = 5 * 60 * 1000;

interface LanConnection {
  socket: net.Socket;
  outbound: boolean;
  remoteAddress: string;
  decoder: WireFrameDecoder;
  inputBytes: number;
  frameCount: number;
  binding: ConnectionBinding;
  pairingDeadlineActive: boolean;
}

export interface LanServiceOptions {
  device: PairingDevice;
  pairingApi: PairingApi;
  capabilities?: string[];
  maxConnections?: number;
  maxConnectionsPerIp?: number;
  bootstrapTimeoutMs?: number;
  maxBootstrapBytes?: number;
  maxBootstrapFrames?: number;
  enableDiscovery?: boolean;
}

export class LanService extends EventEmitter {
  device: PairingDevice;
  pairingApi: PairingApi;
  capabilities: string[];
  maxConnections: number;
  maxConnectionsPerIp: number;
  bootstrapTimeoutMs: number;
  maxBootstrapBytes: number;
  maxBootstrapFrames: number;
  enableDiscovery: boolean;
  router: PairingRouter;
  private server: net.Server | null = null;
  private port: number | null = null;
  private discovery: V2Discovery | null = null;
  private connections = new Set<LanConnection>();
  private connectionsByPairingId = new Map<string, LanConnection>();
  private connectionsPerIp = new Map<string, number>();

  constructor({
    device,
    pairingApi,
    capabilities = ['pairing'],
    maxConnections = DEFAULT_MAX_CONNECTIONS,
    maxConnectionsPerIp = DEFAULT_MAX_CONNECTIONS_PER_IP,
    bootstrapTimeoutMs = DEFAULT_BOOTSTRAP_TIMEOUT_MS,
    maxBootstrapBytes = DEFAULT_MAX_BOOTSTRAP_BYTES,
    maxBootstrapFrames = DEFAULT_MAX_BOOTSTRAP_FRAMES,
    enableDiscovery = true,
  }: LanServiceOptions) {
    super();
    if (!device || typeof device.signingPrivateKey !== 'string') throw new TypeError('A signing-capable local device is required');
    if (!pairingApi || typeof pairingApi.startPairing !== 'function' || typeof pairingApi.createLocalConfirmation !== 'function' || typeof pairingApi.createResponderOffer !== 'function' || typeof pairingApi.getPairingSession !== 'function' || typeof pairingApi.complete !== 'function') {
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
    this.router = new PairingRouter({ pairingApi: this.pairingApi });
  }

  async start(port: number = 0): Promise<number> {
    if (this.server) return this.port!;
    const server = net.createServer((socket) => this.acceptSocket(socket));
    server.maxConnections = this.maxConnections;
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => { server.off('listening', onListening); reject(error); };
      const onListening = () => { server.off('error', onError); resolve(); };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, '0.0.0.0');
    });
    this.port = (server.address() as net.AddressInfo).port;
    if (this.enableDiscovery) {
      this.discovery = new V2Discovery({ device: this.device, port: this.port, capabilities: this.capabilities });
      this.discovery.on('peer', (peer: DiscoveredPeerEntry) => this.emit('peer', peer));
      this.discovery.on('peers', (peers: DiscoveredPeerEntry[]) => this.emit('peers', peers));
      this.discovery.on('error', (error: Error) => this.emit('error', error));
      this.discovery.start();
    }
    return this.port;
  }

  async stop(): Promise<void> {
    if (this.discovery) this.discovery.stop();
    this.discovery = null;
    for (const connection of Array.from(this.connections)) connection.socket.destroy();
    this.connections.clear();
    this.connectionsByPairingId.clear();
    this.connectionsPerIp.clear();
    const server = this.server;
    this.server = null;
    this.port = null;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  listPeers(): DiscoveredPeerEntry[] {
    return this.discovery ? this.discovery.listPeers() : [];
  }

  async startPairing(peer: { host: string; port: number; deviceId: string }, { capabilities = this.capabilities } = {}): Promise<unknown> {
    assertPeerEndpoint(peer);
    const started = this.pairingApi.startPairing!({ capabilities });
    const connection = await this.connect(peer.host, peer.port, peer.deviceId);
    connection.binding.pairingId = started.session.pairingId;
    this.connectionsByPairingId.set(started.session.pairingId, connection);
    this.sendControl(connection, MESSAGE_TYPES.PAIRING_OFFER, started.outboundOffer as Record<string, unknown>);
    this.activatePairingDeadline(connection);
    return this.requireSession(started.session.pairingId);
  }

  confirmPairing(pairingId: string, { capabilities = this.capabilities } = {}): unknown {
    const connection = this.requireConnection(pairingId);
    const session = this.requireSession(pairingId) as { role: string };
    if (session.role === 'responder') {
      const responderOffer = this.pairingApi.createResponderOffer!(pairingId, { capabilities });
      this.sendControl(connection, MESSAGE_TYPES.PAIRING_OFFER, { offer: responderOffer.offer, signature: responderOffer.signature });
      this.activatePairingDeadline(connection);
    }
    const confirmation = this.pairingApi.createLocalConfirmation!(pairingId);
    this.sendControl(connection, MESSAGE_TYPES.PAIRING_CONFIRM, { confirmation: confirmation.confirmation, signature: confirmation.signature });
    this.emitSession(pairingId);
    return this.requireSession(pairingId);
  }

  completePairing(pairingId: string, options?: unknown): unknown {
    const peer = this.pairingApi.complete!(pairingId, options);
    this.emitSession(pairingId);
    return peer;
  }

  cancelPairing(pairingId: string, reason: string = 'user-cancelled'): unknown {
    const connection = this.connectionsByPairingId.get(pairingId);
    this.requireSession(pairingId);
    if (connection && !connection.socket.destroyed && connection.binding.remoteDeviceId) {
      const cancellation = createPairingCancel({ pairingId, device: this.device, reason });
      this.sendControl(connection, MESSAGE_TYPES.PAIRING_CANCEL, { cancellation, signature: signPairingCancel(cancellation, this.device.signingPrivateKey) });
    }
    const result = this.pairingApi.cancel(pairingId, reason);
    this.emitSession(pairingId);
    return result;
  }

  private acceptSocket(socket: net.Socket): void {
    if (this.connections.size >= this.maxConnections) { socket.destroy(); return; }
    const remoteAddress = socket.remoteAddress || 'unknown';
    if ((this.connectionsPerIp.get(remoteAddress) || 0) >= this.maxConnectionsPerIp) { socket.destroy(); return; }
    this.registerSocket(socket, { outbound: false });
  }

  private connect(host: string, port: number, expectedDeviceId: string | null): Promise<LanConnection> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host, port });
      const onError = (error: Error) => { socket.off('connect', onConnect); reject(error); };
      const onConnect = () => {
        socket.off('error', onError);
        try {
          resolve(this.registerSocket(socket, { outbound: true, expectedDeviceId }));
        } catch (error) {
          socket.destroy();
          reject(error);
        }
      };
      socket.once('error', onError);
      socket.once('connect', onConnect);
    });
  }

  private registerSocket(socket: net.Socket, { outbound, expectedDeviceId = null }: { outbound: boolean; expectedDeviceId?: string | null }): LanConnection {
    if (this.connections.size >= this.maxConnections) throw new Error('Too many pairing connections');
    const remoteAddress = socket.remoteAddress || 'unknown';
    const count = this.connectionsPerIp.get(remoteAddress) || 0;
    if (count >= this.maxConnectionsPerIp) throw new Error('Too many pairing connections from this address');
    const connection: LanConnection = {
      socket,
      outbound,
      remoteAddress,
      decoder: new WireFrameDecoder(),
      inputBytes: 0,
      frameCount: 0,
      binding: { expectedDeviceId: expectedDeviceId ?? undefined } as ConnectionBinding,
      pairingDeadlineActive: false,
    };
    this.connections.add(connection);
    this.connectionsPerIp.set(remoteAddress, count + 1);
    socket.setNoDelay(true);
    socket.setTimeout(this.bootstrapTimeoutMs, () => socket.destroy());
    socket.on('data', (chunk: Buffer) => this.onData(connection, chunk));
    socket.on('error', (error: Error) => this.emit('connection-error', { remoteAddress, error }));
    socket.on('close', () => this.closeConnection(connection));
    return connection;
  }

  private onData(connection: LanConnection, chunk: Buffer): void {
    try {
      connection.inputBytes += chunk.length;
      if (connection.inputBytes > this.maxBootstrapBytes) throw new RangeError('Pairing bootstrap input exceeds the accepted limit');
      const frames = connection.decoder.push(chunk);
      for (const frame of frames) {
        connection.frameCount += 1;
        if (connection.frameCount > this.maxBootstrapFrames) throw new RangeError('Pairing bootstrap frame count exceeds the accepted limit');
        const result = this.router.receiveFrame(frame as WireFrame, connection.binding);
        if (result.kind === 'offer') this.activatePairingDeadline(connection);
        if (connection.binding.pairingId) this.connectionsByPairingId.set(connection.binding.pairingId, connection);
        if (result.kind === 'cancellation') connection.socket.end();
        this.emitSession(connection.binding.pairingId);
      }
    } catch (error) {
      this.emit('protocol-error', { remoteAddress: connection.remoteAddress, error });
      connection.socket.destroy();
    }
  }

  private activatePairingDeadline(connection: LanConnection): void {
    if (!connection || connection.pairingDeadlineActive || connection.socket.destroyed) return;
    connection.socket.setTimeout(PAIRING_SESSION_TTL_MS);
    connection.pairingDeadlineActive = true;
  }

  private sendControl(connection: LanConnection, type: string, message: Record<string, unknown>): void {
    if (!connection || connection.socket.destroyed) throw new Error('Pairing connection is unavailable');
    const frame = encodeWireFrame({ header: { app: APP_ID, protocolVersion: PROTOCOL_VERSION, type }, payload: encodeControlMessage(type, message) });
    if (frame.length > this.maxBootstrapBytes) throw new RangeError('Pairing control frame exceeds the accepted limit');
    connection.socket.write(frame);
  }

  private requireConnection(pairingId: string): LanConnection {
    const connection = this.connectionsByPairingId.get(pairingId);
    if (!connection || connection.socket.destroyed) throw new Error('Pairing connection is unavailable');
    return connection;
  }

  private requireSession(pairingId: string): unknown {
    const session = this.pairingApi.getPairingSession(pairingId);
    if (!session) throw new Error('Pairing session is not active');
    return session;
  }

  private emitSession(pairingId?: string): void {
    if (!pairingId) return;
    const session = this.pairingApi.listPairingSessions().find((item) => item.pairingId === pairingId) || null;
    this.emit('pairing-session', session);
  }

  private closeConnection(connection: LanConnection): void {
    if (!this.connections.delete(connection)) return;
    const count = this.connectionsPerIp.get(connection.remoteAddress) || 0;
    if (count <= 1) this.connectionsPerIp.delete(connection.remoteAddress);
    else this.connectionsPerIp.set(connection.remoteAddress, count - 1);
    if (connection.binding.pairingId && this.connectionsByPairingId.get(connection.binding.pairingId) === connection) {
      this.connectionsByPairingId.delete(connection.binding.pairingId);
    }
    try { connection.decoder.finish(); } catch { /* socket already failed or truncated */ }
  }
}

function assertPeerEndpoint(peer: { host?: string; port?: number; deviceId?: string }): void {
  if (!peer || typeof peer !== 'object' || typeof peer.host !== 'string' || peer.host.length === 0 || !Number.isSafeInteger(peer.port) || peer.port! < 1 || peer.port! > 65535 || !/^[a-f0-9]{16}$/.test(peer.deviceId || '')) {
    throw new TypeError('A valid v2 discovery peer endpoint is required');
  }
}

function normalizeCapabilities(capabilities: string[]): string[] {
  if (!Array.isArray(capabilities)) throw new TypeError('Capabilities must be an array');
  return capabilities.slice();
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive integer`);
  return value;
}

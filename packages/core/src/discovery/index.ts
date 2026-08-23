/**
 * v2 UDP multicast discovery: announce this device, listen for peers, dedup,
 * and expire stale peers by TTL.
 *
 * Ported from src/v2/discovery.js. Uses node:dgram for the transport and
 * Ed25519 signatures for announcement authenticity. Each announcement carries
 * the device's public identity (deviceId, signingPublicKey, encryptionPublicKey,
 * fingerprint) so receivers can verify the sender and dedup by identity.
 */

import crypto from 'node:crypto';
import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';
import { Buffer } from 'node:buffer';
import { TextDecoder } from 'node:util';
import { APP_ID, MESSAGE_TYPES, PROTOCOL_VERSION } from '../constants.js';
import { canonicalJson, parseCanonicalJson, type CanonicalValue } from '../canonical-json.js';
import { multicastInterfaces } from './multicast-interfaces.js';
import { assertValidPublicIdentity, publicIdentity, normalizeCapabilities, type PublicIdentity } from '../pairing/identity-shape.js';

export const MULTICAST_ADDRESS = '239.255.77.77';
export const DISCOVERY_PORT = 47777;
export const ANNOUNCE_INTERVAL_MS = 2000;
export const PEER_TTL_MS = 10000;
export const MAX_ANNOUNCEMENT_BYTES = 16 * 1024;
export const DISCOVERY_MAX_CLOCK_SKEW_MS = 30 * 1000;
const CAPABILITY_PATTERN = /^[a-z][a-z0-9-]*$/;
const utf8Decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export interface DiscoveryDevice {
  deviceId: string;
  deviceName: string;
  fingerprint: string;
  signingPublicKey: string;
  encryptionPublicKey: string;
  signingPrivateKey: string;
}

export interface DiscoveredPeerEntry {
  deviceId: string;
  deviceName: string;
  fingerprint: string;
  signingPublicKey: string;
  encryptionPublicKey: string;
  host: string;
  port: number;
  capabilities: string[];
  lastSeen: number;
}

export interface DiscoveryAnnouncement {
  app: string;
  protocolVersion: number;
  type: string;
  issuedAt: number;
  identity: PublicIdentity;
  port: number;
  capabilities: string[];
  signature?: string;
}

export interface V2DiscoveryOptions {
  device: DiscoveryDevice;
  port: number;
  capabilities?: string[];
  announceIntervalMs?: number;
  peerTtlMs?: number;
}

export class V2Discovery extends EventEmitter {
  device: DiscoveryDevice;
  port: number;
  capabilities: string[];
  announceIntervalMs: number;
  peerTtlMs: number;
  private socket: dgram.Socket | null = null;
  private peers = new Map<string, DiscoveredPeerEntry>();
  private announceTimer: NodeJS.Timeout | null = null;
  private pruneTimer: NodeJS.Timeout | null = null;
  private multicastInterfaceList: string[] = [];

  constructor({ device, port, capabilities = [], announceIntervalMs = ANNOUNCE_INTERVAL_MS, peerTtlMs = PEER_TTL_MS }: V2DiscoveryOptions) {
    super();
    assertValidPublicIdentity(device);
    assertPort(port);
    this.device = device;
    this.port = port;
    this.capabilities = normalizeCapabilities(capabilities);
    this.announceIntervalMs = positiveInteger(announceIntervalMs, 'announceIntervalMs');
    this.peerTtlMs = positiveInteger(peerTtlMs, 'peerTtlMs');
  }

  start(): void {
    if (this.socket) return;
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.socket = socket;
    socket.on('message', (message, remote) => this.handleMessage(message, remote));
    socket.on('error', (error) => this.emit('error', error));
    socket.bind(DISCOVERY_PORT, () => {
      if (socket !== this.socket) return;
      this.configureMulticast(socket);
      this.announce();
      this.announceTimer = setInterval(() => this.announce(), this.announceIntervalMs);
      this.pruneTimer = setInterval(() => this.prunePeers(), this.announceIntervalMs);
    });
  }

  stop(): void {
    if (this.announceTimer) clearInterval(this.announceTimer);
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    this.announceTimer = null;
    this.pruneTimer = null;
    if (this.socket) this.socket.close();
    this.socket = null;
    this.multicastInterfaceList = [];
    this.peers.clear();
  }

  announce(now: number = Date.now()): void {
    if (!this.socket) return;
    try {
      const announcement = createDiscoveryAnnouncement({
        device: this.device,
        port: this.port,
        capabilities: this.capabilities,
        issuedAt: now,
      });
      const encoded = Buffer.from(
        canonicalJson({
          ...announcement,
          signature: signDiscoveryAnnouncement(announcement, this.device.signingPrivateKey),
        } as unknown as CanonicalValue),
        'utf8',
      );
      const interfaces = this.multicastInterfaceList;
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

  listPeers(): DiscoveredPeerEntry[] {
    return Array.from(this.peers.values()).sort((left, right) => left.deviceName.localeCompare(right.deviceName));
  }

  getPeer(deviceId: string): DiscoveredPeerEntry | null {
    return this.peers.get(deviceId) ?? null;
  }

  private configureMulticast(socket: dgram.Socket): void {
    socket.setMulticastTTL(1);
    socket.setMulticastLoopback(true);
    const joined: string[] = [];
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
    this.multicastInterfaceList = joined;
  }

  private handleMessage(message: Buffer, remote: dgram.RemoteInfo, now: number = Date.now()): void {
    let announcement: DiscoveryAnnouncement;
    try {
      announcement = parseDiscoveryDatagram(message);
      assertFreshDiscoveryAnnouncement(announcement, now);
      if (announcement.identity.deviceId === this.device.deviceId || !verifyDiscoveryAnnouncement(announcement, announcement.signature)) return;
    } catch {
      return;
    }

    const nextPeer: DiscoveredPeerEntry = {
      deviceId: announcement.identity.deviceId,
      deviceName: announcement.identity.deviceName,
      fingerprint: announcement.identity.fingerprint,
      signingPublicKey: announcement.identity.signingPublicKey,
      encryptionPublicKey: announcement.identity.encryptionPublicKey,
      host: remote.address,
      port: announcement.port,
      capabilities: announcement.capabilities,
      lastSeen: now,
    };
    const previous = this.peers.get(nextPeer.deviceId);
    this.peers.set(nextPeer.deviceId, nextPeer);
    if (!previous || !samePeerEndpoint(previous, nextPeer)) {
      this.emit('peer', nextPeer);
      this.emit('peers', this.listPeers());
    }
  }

  private prunePeers(now: number = Date.now()): void {
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

export function createDiscoveryAnnouncement({
  device,
  port,
  capabilities = [],
  issuedAt = Date.now(),
}: {
  device: DiscoveryDevice;
  port: number;
  capabilities?: string[];
  issuedAt?: number;
}): DiscoveryAnnouncement {
  const announcement: DiscoveryAnnouncement = {
    app: APP_ID,
    protocolVersion: PROTOCOL_VERSION,
    type: MESSAGE_TYPES.DISCOVERY_ANNOUNCE,
    issuedAt,
    identity: publicIdentity(device),
    port,
    capabilities: normalizeCapabilities(capabilities),
  };
  assertValidDiscoveryAnnouncement(announcement);
  return announcement;
}

export function discoveryAnnouncementSigningPayload(announcement: DiscoveryAnnouncement): string {
  assertValidDiscoveryAnnouncement(announcement);
  return canonicalJson({
    app: announcement.app,
    protocolVersion: announcement.protocolVersion,
    type: announcement.type,
    issuedAt: announcement.issuedAt,
    identity: publicIdentity(announcement.identity),
    port: announcement.port,
    capabilities: normalizeCapabilities(announcement.capabilities),
  } as unknown as CanonicalValue);
}

export function signDiscoveryAnnouncement(announcement: DiscoveryAnnouncement, privateKeyPem: string): string {
  return crypto.sign(null, Buffer.from(discoveryAnnouncementSigningPayload(announcement), 'utf8'), crypto.createPrivateKey(privateKeyPem)).toString('base64');
}

export function verifyDiscoveryAnnouncement(announcement: DiscoveryAnnouncement, signature: string | undefined): boolean {
  try {
    assertValidDiscoveryAnnouncement(announcement);
    if (typeof signature !== 'string' || signature.length === 0 || signature.length > 512) return false;
    return crypto.verify(null, Buffer.from(discoveryAnnouncementSigningPayload(announcement), 'utf8'), crypto.createPublicKey(announcement.identity.signingPublicKey), Buffer.from(signature, 'base64'));
  } catch {
    return false;
  }
}

export function parseDiscoveryDatagram(message: Buffer | Uint8Array): DiscoveryAnnouncement {
  const buf = Buffer.isBuffer(message) ? message : Buffer.from(message);
  if (buf.length === 0 || buf.length > MAX_ANNOUNCEMENT_BYTES) {
    throw new RangeError('Discovery datagram exceeds the accepted bounds');
  }
  const serialized = utf8Decoder.decode(buf);
  const parsed = parseCanonicalJson(serialized, 'Discovery announcement') as Record<string, unknown>;
  assertExactKeys(parsed, ['app', 'protocolVersion', 'type', 'issuedAt', 'identity', 'port', 'capabilities', 'signature'], 'Discovery announcement');
  const announcement = parsed as unknown as DiscoveryAnnouncement;
  assertValidDiscoveryAnnouncement(announcement);
  if (typeof announcement.signature !== 'string' || announcement.signature.length === 0 || announcement.signature.length > 512) {
    throw new TypeError('Discovery announcement signature is invalid');
  }
  return announcement;
}

export function assertValidDiscoveryAnnouncement(announcement: unknown): asserts announcement is DiscoveryAnnouncement {
  assertPlainObject(announcement, 'Discovery announcement');
  const ann = announcement as Record<string, unknown>;
  assertExactKeys(ann, ['app', 'protocolVersion', 'type', 'issuedAt', 'identity', 'port', 'capabilities'], 'Discovery announcement', ['signature']);
  if (ann.app !== APP_ID || ann.protocolVersion !== PROTOCOL_VERSION || ann.type !== MESSAGE_TYPES.DISCOVERY_ANNOUNCE) {
    throw new TypeError('Discovery announcement has an unsupported protocol envelope');
  }
  if (!Number.isSafeInteger(ann.issuedAt) || (ann.issuedAt as number) <= 0) {
    throw new TypeError('Discovery announcement issue time is invalid');
  }
  assertValidPublicIdentity(ann.identity);
  assertPort(ann.port as number);
  normalizeCapabilities(ann.capabilities);
}

export function assertFreshDiscoveryAnnouncement(announcement: DiscoveryAnnouncement, now: number = Date.now()): void {
  assertValidDiscoveryAnnouncement(announcement);
  if (!Number.isSafeInteger(now) || now <= 0 || Math.abs(now - announcement.issuedAt) > DISCOVERY_MAX_CLOCK_SKEW_MS) {
    throw new Error('Discovery announcement is stale or has an invalid clock');
  }
}

function assertPort(port: number): void {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new TypeError('Discovery port is invalid');
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive integer`);
  return value;
}

function samePeerEndpoint(left: DiscoveredPeerEntry, right: DiscoveredPeerEntry): boolean {
  return (
    left.deviceName === right.deviceName &&
    left.host === right.host &&
    left.port === right.port &&
    left.fingerprint === right.fingerprint &&
    canonicalJson(left.capabilities as unknown as CanonicalValue) ===
      canonicalJson(right.capabilities as unknown as CanonicalValue)
  );
}

function assertPlainObject(value: unknown, name: string): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new TypeError(`${name} must be a plain object`);
  }
}

function assertExactKeys(value: Record<string, unknown>, required: string[], name: string, optional: string[] = []): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of required) if (!Object.hasOwn(value, key)) throw new TypeError(`${name} is missing ${key}`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`${name} contains unknown field ${key}`);
}

// Suppress unused-import lint for CAPABILITY_PATTERN (retained for parity with
// the original; normalizeCapabilities in identity-shape.ts enforces the same).
void CAPABILITY_PATTERN;

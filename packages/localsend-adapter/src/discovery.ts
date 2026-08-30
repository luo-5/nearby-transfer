/**
 * LocalSend discovery adapter: UDP multicast announce and listen.
 *
 * Listens for LocalSend device announcements on 224.0.0.167:53317 and emits
 * LocalSendDevice events. Can also announce this device so LocalSend apps
 * can discover us.
 */

import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';
import { Buffer } from 'node:buffer';
import { TextDecoder } from 'node:util';
import {
  LOCALSEND_MULTICAST_ADDRESS,
  LOCALSEND_PORT,
  type LocalSendDeviceInfo,
  type LocalSendDevice,
} from './types.js';
import { multicastInterfaces } from '@luo-5/core';

const utf8Decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const MAX_DISCOVERY_DATAGRAM_BYTES = 16 * 1024;
const DEFAULT_PEER_TTL_MS = 30 * 1000;
const DEFAULT_MAX_PEERS = 256;

export interface LocalSendDiscoveryOptions {
  alias: string;
  fingerprint: string;
  port: number;
  deviceModel?: string;
  deviceType?: 'mobile' | 'desktop' | 'web' | 'headless' | 'server';
  protocol?: 'http' | 'https';
  download?: boolean;
  announceIntervalMs?: number;
  peerTtlMs?: number;
  maxPeers?: number;
}

export class LocalSendDiscovery extends EventEmitter {
  private alias: string;
  private fingerprint: string;
  private port: number;
  private deviceModel: string;
  private deviceType: 'mobile' | 'desktop' | 'web' | 'headless' | 'server';
  private protocol: 'http' | 'https';
  private download: boolean;
  private announceIntervalMs: number;
  private peerTtlMs: number;
  private maxPeers: number;
  private socket: dgram.Socket | null = null;
  private announceTimer: NodeJS.Timeout | null = null;
  private pruneTimer: NodeJS.Timeout | null = null;
  private peers = new Map<string, LocalSendDevice>();
  private peerLastSeen = new Map<string, number>();

  constructor(opts: LocalSendDiscoveryOptions) {
    super();
    this.alias = opts.alias;
    this.fingerprint = opts.fingerprint;
    this.port = opts.port;
    this.deviceModel = opts.deviceModel ?? 'Nearby Transfer CLI';
    this.deviceType = opts.deviceType ?? 'headless';
    this.protocol = opts.protocol ?? 'http';
    this.download = opts.download ?? false;
    this.announceIntervalMs = positiveInteger(opts.announceIntervalMs, 5000, 'announceIntervalMs');
    this.peerTtlMs = positiveInteger(opts.peerTtlMs, DEFAULT_PEER_TTL_MS, 'peerTtlMs');
    this.maxPeers = positiveInteger(opts.maxPeers, DEFAULT_MAX_PEERS, 'maxPeers');
    validateAnnouncementInfo(this.getAnnouncementInfo());
  }

  start(): void {
    if (this.socket) return;
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.socket = socket;

    socket.on('message', (msg, rinfo) => this.handleMessage(msg, rinfo));
    socket.on('error', (error) => {
      if (this.socket === socket) {
        this.clearTimers();
        this.socket = null;
      }
      this.emit('error', error);
    });

    socket.bind(LOCALSEND_PORT, () => {
      if (this.socket !== socket) {
        try { socket.close(); } catch { /* already closed */ }
        return;
      }
      socket.setMulticastTTL(1);
      socket.setMulticastLoopback(true);
      const interfaces = multicastInterfaces();
      for (const iface of interfaces) {
        try {
          socket.addMembership(LOCALSEND_MULTICAST_ADDRESS, iface);
        } catch {
          // ignore
        }
      }
      if (interfaces.length === 0) {
        try {
          socket.addMembership(LOCALSEND_MULTICAST_ADDRESS);
        } catch {
          // ignore
        }
      }
      this.announce();
      this.announceTimer = setInterval(() => this.announce(), this.announceIntervalMs);
      this.pruneTimer = setInterval(() => this.prunePeers(), Math.min(this.announceIntervalMs, this.peerTtlMs));
    });
  }

  stop(): void {
    this.clearTimers();
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      try { socket.close(); } catch { /* already closed */ }
    }
    this.peers.clear();
    this.peerLastSeen.clear();
  }

  private clearTimers(): void {
    if (this.announceTimer) clearInterval(this.announceTimer);
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    this.announceTimer = null;
    this.pruneTimer = null;
  }

  listPeers(): LocalSendDevice[] {
    return Array.from(this.peers.values());
  }

  private announce(): void {
    if (!this.socket) return;
    const info = this.getAnnouncementInfo();
    const payload = Buffer.from(JSON.stringify(info), 'utf8');
    this.socket.send(payload, 0, payload.length, LOCALSEND_PORT, LOCALSEND_MULTICAST_ADDRESS);
  }

  private getAnnouncementInfo(): LocalSendDeviceInfo {
    return {
      alias: this.alias,
      version: '2.0',
      deviceModel: this.deviceModel,
      deviceType: this.deviceType,
      fingerprint: this.fingerprint,
      port: this.port,
      protocol: this.protocol,
      download: this.download,
      announce: true,
    };
  }

  private handleMessage(msg: Buffer, rinfo: dgram.RemoteInfo): void {
    if (msg.length === 0 || msg.length > MAX_DISCOVERY_DATAGRAM_BYTES) return;
    let info: LocalSendDeviceInfo;
    try {
      const text = utf8Decoder.decode(msg);
      info = validateAnnouncementInfo(JSON.parse(text));
    } catch {
      return;
    }

    if (!info.fingerprint || info.fingerprint === this.fingerprint) return;

    const device: LocalSendDevice = {
      fingerprint: info.fingerprint,
      alias: info.alias,
      host: rinfo.address,
      port: info.port,
      protocol: info.protocol,
      deviceType: info.deviceType,
      deviceModel: info.deviceModel,
      version: info.version,
      download: info.download,
    };

    const now = Date.now();
    this.prunePeers(now);
    const previous = this.peers.get(device.fingerprint);
    if (!previous && this.peers.size >= this.maxPeers) return;
    this.peers.set(device.fingerprint, device);
    this.peerLastSeen.set(device.fingerprint, now);
    if (!previous || !sameDevice(previous, device)) {
      this.emit('peer', device);
      this.emit('peers', this.listPeers());
    }
  }

  private prunePeers(now = Date.now()): void {
    let changed = false;
    for (const [fingerprint, lastSeen] of this.peerLastSeen) {
      if (now - lastSeen > this.peerTtlMs) {
        this.peerLastSeen.delete(fingerprint);
        this.peers.delete(fingerprint);
        changed = true;
      }
    }
    if (changed) this.emit('peers', this.listPeers());
  }
}

/** Create a LocalSend device info object for announcements. */
export function createDeviceInfo(opts: {
  alias: string;
  fingerprint: string;
  port: number;
  deviceModel?: string;
  deviceType?: 'mobile' | 'desktop' | 'web' | 'headless' | 'server';
  protocol?: 'http' | 'https';
  download?: boolean;
}): LocalSendDeviceInfo {
  return validateAnnouncementInfo({
    alias: opts.alias,
    version: '2.0',
    deviceModel: opts.deviceModel ?? 'Nearby Transfer',
    deviceType: opts.deviceType ?? 'headless',
    fingerprint: opts.fingerprint,
    port: opts.port,
    protocol: opts.protocol ?? 'http',
    download: opts.download ?? false,
    announce: true,
  });
}

function validateAnnouncementInfo(value: unknown): LocalSendDeviceInfo {
  if (!isRecord(value)
    || typeof value.alias !== 'string' || value.alias.length === 0 || value.alias.length > 128
    || typeof value.version !== 'string' || value.version.length === 0 || value.version.length > 32
    || typeof value.fingerprint !== 'string' || value.fingerprint.length === 0 || value.fingerprint.length > 256
    || !Number.isSafeInteger(value.port) || (value.port as number) < 1 || (value.port as number) > 65535
    || (value.protocol !== 'http' && value.protocol !== 'https')) {
    throw new TypeError('LocalSend announcement is invalid');
  }
  const deviceModel = value.deviceModel == null ? 'Unknown' : value.deviceModel;
  const deviceType = value.deviceType == null ? 'desktop' : value.deviceType;
  if (typeof deviceModel !== 'string' || deviceModel.length > 128 || typeof deviceType !== 'string') {
    throw new TypeError('LocalSend announcement is invalid');
  }
  const normalizedType = ['mobile', 'desktop', 'web', 'headless', 'server'].includes(deviceType)
    ? deviceType as LocalSendDeviceInfo['deviceType']
    : 'desktop';
  return {
    alias: value.alias,
    version: value.version,
    deviceModel,
    deviceType: normalizedType,
    fingerprint: value.fingerprint,
    port: value.port as number,
    protocol: value.protocol,
    download: value.download === true,
    announce: value.announce === true,
  };
}

function positiveInteger(value: number | undefined, fallback: number, label: string): number {
  const normalized = value ?? fallback;
  if (!Number.isSafeInteger(normalized) || normalized <= 0) throw new TypeError(`${label} must be a positive integer`);
  return normalized;
}

function sameDevice(left: LocalSendDevice, right: LocalSendDevice): boolean {
  return left.alias === right.alias && left.host === right.host && left.port === right.port
    && left.protocol === right.protocol && left.deviceType === right.deviceType
    && left.deviceModel === right.deviceModel && left.version === right.version && left.download === right.download;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

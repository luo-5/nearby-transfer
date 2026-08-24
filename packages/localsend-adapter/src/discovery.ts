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

export interface LocalSendDiscoveryOptions {
  alias: string;
  fingerprint: string;
  port: number;
  deviceModel?: string;
  deviceType?: 'mobile' | 'desktop' | 'web' | 'headless' | 'server';
  protocol?: 'http' | 'https';
  download?: boolean;
  announceIntervalMs?: number;
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
  private socket: dgram.Socket | null = null;
  private announceTimer: NodeJS.Timeout | null = null;
  private peers = new Map<string, LocalSendDevice>();

  constructor(opts: LocalSendDiscoveryOptions) {
    super();
    this.alias = opts.alias;
    this.fingerprint = opts.fingerprint;
    this.port = opts.port;
    this.deviceModel = opts.deviceModel ?? 'Nearby Transfer CLI';
    this.deviceType = opts.deviceType ?? 'headless';
    this.protocol = opts.protocol ?? 'http';
    this.download = opts.download ?? false;
    this.announceIntervalMs = opts.announceIntervalMs ?? 5000;
  }

  start(): void {
    if (this.socket) return;
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.socket = socket;

    socket.on('message', (msg, rinfo) => this.handleMessage(msg, rinfo));
    socket.on('error', (error) => this.emit('error', error));

    socket.bind(LOCALSEND_PORT, () => {
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
    });
  }

  stop(): void {
    if (this.announceTimer) clearInterval(this.announceTimer);
    this.announceTimer = null;
    if (this.socket) this.socket.close();
    this.socket = null;
    this.peers.clear();
  }

  listPeers(): LocalSendDevice[] {
    return Array.from(this.peers.values());
  }

  private announce(): void {
    if (!this.socket) return;
    const info: LocalSendDeviceInfo = {
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
    const payload = Buffer.from(JSON.stringify(info), 'utf8');
    this.socket.send(payload, 0, payload.length, LOCALSEND_PORT, LOCALSEND_MULTICAST_ADDRESS);
  }

  private handleMessage(msg: Buffer, rinfo: dgram.RemoteInfo): void {
    let info: LocalSendDeviceInfo;
    try {
      const text = utf8Decoder.decode(msg);
      info = JSON.parse(text) as LocalSendDeviceInfo;
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

    const previous = this.peers.get(device.fingerprint);
    this.peers.set(device.fingerprint, device);
    if (!previous) {
      this.emit('peer', device);
    }
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
  return {
    alias: opts.alias,
    version: '2.0',
    deviceModel: opts.deviceModel ?? 'Nearby Transfer',
    deviceType: opts.deviceType ?? 'headless',
    fingerprint: opts.fingerprint,
    port: opts.port,
    protocol: opts.protocol ?? 'http',
    download: opts.download ?? false,
    announce: true,
  };
}

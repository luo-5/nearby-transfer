/**
 * Protocol identifiers, categories, and base driver class.
 * Ported from src/protocols/protocol-types.js.
 */

export const PROTOCOLS = {
  V2_STREAM: 'v2-stream',
  TURBO_PARALLEL: 'turbo-parallel',
  QUIC_UDP: 'quic-udp',
  SMB_SHARE: 'smb-share',
  WEBDAV_SYNC: 'webdav-sync',
  V1_CLASSIC: 'v1-classic',
  FTPS_SECURE: 'ftps-secure',
} as const;

export const CATEGORIES = {
  FAST: 'fast',
  SYSTEM: 'system',
  STANDARD: 'standard',
} as const;

export type ProtocolId = (typeof PROTOCOLS)[keyof typeof PROTOCOLS];
export type ProtocolCategory = (typeof CATEGORIES)[keyof typeof CATEGORIES];

export interface ProtocolDriverStatus {
  id: string;
  name: string;
  category: string;
  defaultPort: number;
  active: boolean;
  state: string;
}

export interface ProtocolDriverInitResult {
  ok: boolean;
  id: string;
}

export abstract class BaseProtocolDriver {
  id: string;
  name: string;
  category: string;
  defaultPort: number;
  active = false;
  state: string = 'idle';

  constructor(id: string, name: string, category: string, defaultPort: number) {
    this.id = id;
    this.name = name;
    this.category = category;
    this.defaultPort = defaultPort;
  }

  async init(_config: Record<string, unknown> = {}): Promise<ProtocolDriverInitResult> {
    this.active = true;
    this.state = 'ready';
    return { ok: true, id: this.id };
  }

  async sendFile(_peer: unknown, _filePath: string, _options: Record<string, unknown> = {}): Promise<unknown> {
    throw new Error(`sendFile not implemented for ${this.id}`);
  }

  async receiveFile(_session: unknown, _targetDir: string, _options: Record<string, unknown> = {}): Promise<unknown> {
    throw new Error(`receiveFile not implemented for ${this.id}`);
  }

  async pause(_transferId: string): Promise<{ ok: boolean; paused: boolean }> {
    return { ok: true, paused: true };
  }

  async resume(_transferId: string): Promise<{ ok: boolean; resumed: boolean }> {
    return { ok: true, resumed: true };
  }

  async cancel(_transferId: string): Promise<{ ok: boolean; cancelled: boolean }> {
    return { ok: true, cancelled: true };
  }

  async shutdown(): Promise<{ ok: boolean }> {
    this.active = false;
    this.state = 'stopped';
    return { ok: true };
  }

  getStatus(): ProtocolDriverStatus {
    return {
      id: this.id,
      name: this.name,
      category: this.category,
      defaultPort: this.defaultPort,
      active: this.active,
      state: this.state,
    };
  }
}

'use strict';

/**
 * Protocol Identifiers
 */
const PROTOCOLS = {
  V2_STREAM: 'v2-stream',
  TURBO_PARALLEL: 'turbo-parallel',
  QUIC_UDP: 'quic-udp',
  SMB_SHARE: 'smb-share',
  WEBDAV_SYNC: 'webdav-sync',
  V1_CLASSIC: 'v1-classic',
  FTPS_SECURE: 'ftps-secure'
};

/**
 * Protocol Categories
 */
const CATEGORIES = {
  FAST: 'fast',
  SYSTEM: 'system',
  STANDARD: 'standard'
};

/**
 * Base Abstract Protocol Driver
 */
class BaseProtocolDriver {
  constructor(id, name, category, defaultPort) {
    this.id = id;
    this.name = name;
    this.category = category;
    this.defaultPort = defaultPort;
    this.active = false;
    this.state = 'idle';
  }

  async init(config = {}) {
    this.active = true;
    this.state = 'ready';
    return { ok: true, id: this.id };
  }

  async sendFile(peer, filePath, options = {}) {
    throw new Error(`sendFile not implemented for ${this.id}`);
  }

  async receiveFile(session, targetDir, options = {}) {
    throw new Error(`receiveFile not implemented for ${this.id}`);
  }

  async pause(transferId) {
    return { ok: true, paused: true };
  }

  async resume(transferId) {
    return { ok: true, resumed: true };
  }

  async cancel(transferId) {
    return { ok: true, cancelled: true };
  }

  async shutdown() {
    this.active = false;
    this.state = 'stopped';
    return { ok: true };
  }

  getStatus() {
    return {
      id: this.id,
      name: this.name,
      category: this.category,
      defaultPort: this.defaultPort,
      active: this.active,
      state: this.state
    };
  }
}

module.exports = {
  PROTOCOLS,
  CATEGORIES,
  BaseProtocolDriver
};

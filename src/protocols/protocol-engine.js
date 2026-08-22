'use strict';

const { PROTOCOLS, CATEGORIES } = require('./protocol-types');
const { V2StreamDriver } = require('./drivers/v2-stream-driver');
const { TurboParallelDriver } = require('./drivers/turbo-parallel-driver');
const { QuicUdpDriver } = require('./drivers/quic-udp-driver');
const { SmbShareDriver } = require('./drivers/smb-share-driver');
const { WebDavSyncDriver } = require('./drivers/webdav-sync-driver');
const { V1ClassicDriver } = require('./drivers/v1-classic-driver');
const { FtpsSecureDriver } = require('./drivers/ftps-secure-driver');

class ProtocolEngine {
  constructor(defaultProtocol = PROTOCOLS.V2_STREAM) {
    this.drivers = new Map();
    this.activeProtocol = defaultProtocol;
    this._registerDefaultDrivers();
  }

  _registerDefaultDrivers() {
    this.register(new V2StreamDriver());
    this.register(new TurboParallelDriver());
    this.register(new QuicUdpDriver());
    this.register(new SmbShareDriver());
    this.register(new WebDavSyncDriver());
    this.register(new V1ClassicDriver());
    this.register(new FtpsSecureDriver());
  }

  register(driver) {
    if (!driver || !driver.id) {
      throw new Error('Invalid protocol driver');
    }
    this.drivers.set(driver.id, driver);
    return this;
  }

  get(protocolId) {
    return this.drivers.get(protocolId);
  }

  listProtocols(category = null) {
    const list = [];
    for (const driver of this.drivers.values()) {
      if (!category || driver.category === category) {
        list.push({
          ...driver.getStatus(),
          isCurrent: driver.id === this.activeProtocol
        });
      }
    }
    return list;
  }

  async setActiveProtocol(protocolId) {
    if (!this.drivers.has(protocolId)) {
      throw new Error(`Unsupported protocol: ${protocolId}`);
    }
    const previous = this.activeProtocol;
    this.activeProtocol = protocolId;
    const driver = this.drivers.get(protocolId);
    await driver.init();
    return {
      ok: true,
      previous,
      active: this.activeProtocol,
      driverStatus: driver.getStatus()
    };
  }

  getActiveDriver() {
    return this.drivers.get(this.activeProtocol) || this.drivers.get(PROTOCOLS.V2_STREAM);
  }

  async sendFile(peer, filePath, options = {}) {
    const driver = this.getActiveDriver();
    try {
      return await driver.sendFile(peer, filePath, options);
    } catch (err) {
      // Automatic Fallback to V2 Robust Stream if specialized protocol fails
      if (driver.id !== PROTOCOLS.V2_STREAM) {
        const fallbackDriver = this.drivers.get(PROTOCOLS.V2_STREAM);
        return await fallbackDriver.sendFile(peer, filePath, { ...options, fallbackFrom: driver.id });
      }
      throw err;
    }
  }

  async receiveFile(session, targetDir, options = {}) {
    const driver = this.getActiveDriver();
    return await driver.receiveFile(session, targetDir, options);
  }
}

// Global Singleton instance
const protocolEngine = new ProtocolEngine();

module.exports = {
  PROTOCOLS,
  CATEGORIES,
  ProtocolEngine,
  protocolEngine
};

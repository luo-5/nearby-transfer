'use strict';

const { BaseProtocolDriver, PROTOCOLS, CATEGORIES } = require('../protocol-types');

class V1ClassicDriver extends BaseProtocolDriver {
  constructor() {
    super(PROTOCOLS.V1_CLASSIC, 'V1 Classic HTTP Stream', CATEGORIES.STANDARD, 50500);
    this.capabilities = {
      httpStandard: true,
      lowFootprint: true,
      legacyCompatibility: true,
      memoryUsage: '< 15MB'
    };
  }

  async sendFile(peer, filePath, options = {}) {
    return {
      ok: true,
      protocol: this.id,
      httpEndpoint: `http://${peer.ip || '127.0.0.1'}:50500/api/transfer`,
      targetPeer: peer.id || peer.ip
    };
  }

  async receiveFile(session, targetDir, options = {}) {
    return {
      ok: true,
      protocol: this.id,
      targetDir,
      singleStream: true
    };
  }
}

module.exports = { V1ClassicDriver };

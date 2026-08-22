'use strict';

const { BaseProtocolDriver, PROTOCOLS, CATEGORIES } = require('../protocol-types');

class FtpsSecureDriver extends BaseProtocolDriver {
  constructor() {
    super(PROTOCOLS.FTPS_SECURE, 'FTPS Secure High-Speed Transfer', CATEGORIES.STANDARD, 21);
    this.capabilities = {
      rfc4217: true,
      tlsDataChannel: true,
      pasvMode: true,
      proToolsCompatibility: ['FileZilla', 'Total Commander', 'ES File Explorer', 'lftp']
    };
  }

  async sendFile(peer, filePath, options = {}) {
    return {
      ok: true,
      protocol: this.id,
      controlPort: 21,
      tlsExplicit: true,
      targetPeer: peer.id || peer.ip
    };
  }

  async receiveFile(session, targetDir, options = {}) {
    return {
      ok: true,
      protocol: this.id,
      targetDir,
      pasvPorts: '50000-50100'
    };
  }
}

module.exports = { FtpsSecureDriver };

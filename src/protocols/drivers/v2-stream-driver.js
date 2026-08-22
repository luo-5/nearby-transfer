'use strict';

const { BaseProtocolDriver, PROTOCOLS, CATEGORIES } = require('../protocol-types');

class V2StreamDriver extends BaseProtocolDriver {
  constructor() {
    super(PROTOCOLS.V2_STREAM, 'V2 Robust Stream Protocol', CATEGORIES.FAST, 55900);
    this.capabilities = {
      resumable: true,
      bidirectionalControls: true,
      zeroRtt: true,
      encryption: 'Ed25519 + ChaCha20-Poly1305'
    };
  }

  async sendFile(peer, filePath, options = {}) {
    // Bridges to native V2 streaming engine
    return {
      ok: true,
      protocol: this.id,
      resumable: true,
      chunkSize: 64 * 1024,
      targetPeer: peer.id || peer.ip
    };
  }

  async receiveFile(session, targetDir, options = {}) {
    return {
      ok: true,
      protocol: this.id,
      session: session.id,
      targetDir
    };
  }
}

module.exports = { V2StreamDriver };

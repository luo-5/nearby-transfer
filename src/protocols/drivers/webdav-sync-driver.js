'use strict';

const { BaseProtocolDriver, PROTOCOLS, CATEGORIES } = require('../protocol-types');

class WebDavSyncDriver extends BaseProtocolDriver {
  constructor() {
    super(PROTOCOLS.WEBDAV_SYNC, 'WebDAV Direct Cloud Sync', CATEGORIES.SYSTEM, 56578);
    this.capabilities = {
      rfc4918: true,
      httpsTls: true,
      safProvider: true,
      onDemandStreaming: true,
      sseNotifications: true
    };
  }

  async sendFile(peer, filePath, options = {}) {
    return {
      ok: true,
      protocol: this.id,
      webdavUrl: `https://${peer.ip || '127.0.0.1'}:56578/`,
      authScheme: 'Bearer Token / TLS Cert',
      targetPeer: peer.id || peer.ip
    };
  }

  async receiveFile(session, targetDir, options = {}) {
    return {
      ok: true,
      protocol: this.id,
      targetDir,
      syncService: 'active'
    };
  }
}

module.exports = { WebDavSyncDriver };

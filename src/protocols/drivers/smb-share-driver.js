'use strict';

const { BaseProtocolDriver, PROTOCOLS, CATEGORIES } = require('../protocol-types');

class SmbShareDriver extends BaseProtocolDriver {
  constructor() {
    super(PROTOCOLS.SMB_SHARE, 'SMB 3.0 LAN Network Share', CATEGORIES.SYSTEM, 445);
    this.capabilities = {
      osNativeMount: true,
      noClientRequired: true,
      directStreaming: true,
      inPlaceEdit: true,
      supportedOS: ['Windows Explorer', 'macOS Finder', 'Linux Samba / CIFS']
    };
  }

  getShareUri(host, shareName = 'NearbyShare', os = process.platform) {
    if (os === 'win32') {
      return `\\\\${host}\\${shareName}`;
    }
    return `smb://${host}/${shareName}`;
  }

  async sendFile(peer, filePath, options = {}) {
    const shareUri = this.getShareUri(peer.ip || '127.0.0.1', options.shareName);
    return {
      ok: true,
      protocol: this.id,
      shareUri,
      nativeAccess: true,
      targetPeer: peer.id || peer.ip
    };
  }

  async receiveFile(session, targetDir, options = {}) {
    return {
      ok: true,
      protocol: this.id,
      targetDir,
      shareExported: true
    };
  }
}

module.exports = { SmbShareDriver };

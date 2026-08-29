'use strict';

const { createPairingOffer, signPairingOffer } = require('./pairing');
const certManager = require('./cert-manager');

function createDesktopPairingApi({ device, trustedPeerStore, pairingSessionStore }) {
  if (!device || typeof device.signingPrivateKey !== 'string') {
    throw new TypeError('A local device with a signing private key is required');
  }
  if (!trustedPeerStore || typeof trustedPeerStore.listTrustedPeers !== 'function') {
    throw new TypeError('A trusted peer store is required');
  }
  if (!pairingSessionStore || typeof pairingSessionStore.startOutgoing !== 'function') {
    throw new TypeError('A pairing session store is required');
  }

  return Object.freeze({
    listTrustedPeers: () => trustedPeerStore.listTrustedPeers().map(toPublicPeer),
    revokeTrustedPeer: (deviceId) => trustedPeerStore.revokeTrustedPeer(deviceId),
    updateTrustedPeerDisplayName: (deviceId, displayName) =>
      toPublicPeerResult(trustedPeerStore.updateTrustedPeerDisplayName(deviceId, displayName)),
    updateTrustedPeerPermissions: (deviceId, permissions) =>
      toPublicPeerResult(trustedPeerStore.updateTrustedPeerPermissions(deviceId, permissions)),
    updateTrustedPeer: (deviceId, options) =>
      toPublicPeerResult(trustedPeerStore.updateTrustedPeer(deviceId, options)),
    listPairingSessions: () => pairingSessionStore.listActive().map(toPublicSession),
    startPairing: ({ capabilities = [] } = {}) => {
      const started = pairingSessionStore.startOutgoing({
        localDevice: device,
        localPrivateKey: device.signingPrivateKey,
        capabilities
      });
      return {
        session: toPublicSession(started.session),
        outboundOffer: {
          offer: started.offer,
          signature: started.signature
        }
      };
    },
    confirmLocal: (pairingId) => toPublicSession(pairingSessionStore.confirmLocal(pairingId)),
    cancel: (pairingId, reason) => pairingSessionStore.cancel(pairingId, reason),
    getPairingSession: (pairingId) => pairingSessionStore.get(pairingId, { includeTerminal: true }),
    receiveIncomingOffer: (payload) => pairingSessionStore.receiveIncomingOffer({
      offer: payload.offer,
      signature: payload.signature,
      localDevice: device
    }),
    createResponderOffer: (pairingId, { capabilities = [] } = {}) => pairingSessionStore.respondToIncomingOffer(pairingId, {
      localDevice: device,
      localPrivateKey: device.signingPrivateKey,
      capabilities
    }),
    receiveRemoteOffer: (payload) => pairingSessionStore.receiveRemoteOffer({
      pairingId: payload.pairingId,
      offer: payload.offer,
      signature: payload.signature,
      localDevice: device
    }),
    createLocalConfirmation: (pairingId) => pairingSessionStore.createLocalConfirmation(pairingId, {
      localDevice: device,
      localPrivateKey: device.signingPrivateKey
    }),
    receiveRemoteConfirmation: (payload) => pairingSessionStore.receiveRemoteConfirmation({
      pairingId: payload.pairingId,
      confirmation: payload.confirmation,
      signature: payload.signature
    }),
    complete: (pairingId, options) => pairingSessionStore.complete(pairingId, trustedPeerStore, {
      ...options,
      // Pin the local WebDAV certificate into the trust record so clients can
      // verify the library channel after pairing.
      webdavCertFp: certManager.getCertFingerprint()
    })
  });
}

function registerPairingIpcHandlers(ipcMain, api) {
  if (!ipcMain || typeof ipcMain.handle !== 'function') {
    throw new TypeError('ipcMain.handle is required');
  }
  if (!api) {
    throw new TypeError('A desktop pairing API is required');
  }
  ipcMain.handle('v2:list-trusted-peers', () => api.listTrustedPeers());
  ipcMain.handle('v2:revoke-trusted-peer', (_event, deviceId) => api.revokeTrustedPeer(deviceId));
  ipcMain.handle('v2:update-trusted-peer-display-name', (_event, deviceId, displayName) =>
    api.updateTrustedPeerDisplayName(deviceId, displayName));
  ipcMain.handle('v2:update-trusted-peer-permissions', (_event, deviceId, permissions) =>
    api.updateTrustedPeerPermissions(deviceId, permissions));
  ipcMain.handle('v2:update-trusted-peer', (_event, deviceId, options) =>
    api.updateTrustedPeer(deviceId, options));
  ipcMain.handle('v2:list-pairing-sessions', () => api.listPairingSessions());
}

function toPublicPeerResult(peer) {
  return peer ? toPublicPeer(peer) : peer;
}

function toPublicPeer(peer) {
  return {
    deviceId: peer.identity.deviceId,
    deviceName: peer.identity.deviceName,
    displayName: peer.displayName,
    fingerprint: peer.identity.fingerprint,
    permissions: peer.permissions,
    pairedAt: peer.pairedAt,
    lastSeen: peer.lastSeen,
    revokedAt: peer.revokedAt,
    updatedAt: peer.updatedAt,
    webdavCertFp: peer.webdavCertFp
  };
}

function toPublicSession(session) {
  return {
    pairingId: session.pairingId,
    role: session.role,
    status: session.status,
    peer: session.peer ? {
      deviceId: session.peer.identity.deviceId,
      deviceName: session.peer.identity.deviceName,
      fingerprint: session.peer.identity.fingerprint
    } : null,
    pairingCode: session.pairingCode,
    createdAt: session.createdAt,
    expiresAt: session.expiresAt
  };
}

module.exports = {
  createDesktopPairingApi,
  registerPairingIpcHandlers,
  toPublicPeer,
  toPublicSession
};

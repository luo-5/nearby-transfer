'use strict';

function registerLanServiceIpcHandlers(ipcMain, lanService) {
  if (!ipcMain || typeof ipcMain.handle !== 'function') throw new TypeError('ipcMain.handle is required');
  if (!lanService || typeof lanService.listPeers !== 'function') throw new TypeError('A LAN service is required');

  ipcMain.handle('v2:list-discovered-peers', () => lanService.listPeers().map(toPublicDiscoveredPeer));
  ipcMain.handle('v2:start-network-pairing', async (_event, request) => {
    const peerDeviceId = request && typeof request === 'object' && !Array.isArray(request) ? request.peerDeviceId : null;
    const capabilities = request && typeof request === 'object' && !Array.isArray(request) ? request.capabilities : undefined;
    if (typeof peerDeviceId !== 'string') throw new TypeError('A discovered peer device ID is required');
    const peer = lanService.listPeers().find((item) => item.deviceId === peerDeviceId);
    if (!peer) throw new Error('The selected v2 device is no longer available');
    return lanService.startPairing(peer, { capabilities });
  });
  ipcMain.handle('v2:confirm-network-pairing', (_event, pairingId) => lanService.confirmPairing(pairingId));
  ipcMain.handle('v2:complete-network-pairing', (_event, request) => {
    if (!request || typeof request !== 'object' || Array.isArray(request)) throw new TypeError('Pairing completion request is invalid');
    return lanService.completePairing(request.pairingId, {
      displayName: typeof request.displayName === 'string' ? request.displayName : undefined,
      permissions: normalizePermissions(request.permissions)
    });
  });
  ipcMain.handle('v2:cancel-network-pairing', (_event, pairingId) => lanService.cancelPairing(pairingId));
}

function toPublicDiscoveredPeer(peer) {
  return {
    deviceId: peer.deviceId,
    deviceName: peer.deviceName,
    fingerprint: peer.fingerprint,
    capabilities: Array.isArray(peer.capabilities) ? peer.capabilities.slice() : [],
    lastSeen: peer.lastSeen
  };
}

function normalizePermissions(permissions) {
  if (permissions === undefined) return undefined;
  if (!permissions || typeof permissions !== 'object' || Array.isArray(permissions)) throw new TypeError('Permissions are invalid');
  const allowed = new Set(['transfer', 'libraryRead', 'libraryUpload']);
  for (const key of Object.keys(permissions)) {
    if (!allowed.has(key) || typeof permissions[key] !== 'boolean') throw new TypeError('Permissions are invalid');
  }
  return Object.assign({}, permissions);
}

module.exports = {
  registerLanServiceIpcHandlers,
  toPublicDiscoveredPeer
};
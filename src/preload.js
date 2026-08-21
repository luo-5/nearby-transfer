const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('lanTransfer', {
  getState: () => ipcRenderer.invoke('get-state'),
  setLanguage: (lang) => ipcRenderer.send('set-language', lang),
  chooseSaveDirectory: () => ipcRenderer.invoke('choose-save-directory'),
  resetSaveDirectory: () => ipcRenderer.invoke('reset-save-directory'),
  refreshPeers: () => ipcRenderer.invoke('refresh-peers'),
  chooseFile: () => ipcRenderer.invoke('choose-file'),
  selectDroppedFile: (file) => ipcRenderer.invoke('select-dropped-file', webUtils.getPathForFile(file)),
  selectDroppedFiles: (files) => ipcRenderer.invoke('select-dropped-files', (files || []).map(f => webUtils.getPathForFile(f)).filter(Boolean)),
  sendSelectedFileToPeer: (deviceId) => ipcRenderer.invoke('send-selected-file-to-peer', deviceId),
  onBatchProgress: (callback) => ipcRenderer.on('batch-progress', callback),
  chooseAndSend: (deviceId) => ipcRenderer.invoke('choose-and-send', deviceId),
  cancelTransfer: (transferId) => ipcRenderer.invoke('cancel-transfer', transferId),
  pauseTransfer: (transferId) => ipcRenderer.invoke('pause-transfer', transferId),
  resumeTransfer: (transferId) => ipcRenderer.invoke('resume-transfer', transferId),
  openTransferFolder: (filePath) => ipcRenderer.invoke('open-transfer-folder', filePath),
  pairing: Object.freeze({
    listDiscoveredPeers: () => ipcRenderer.invoke('v2:list-discovered-peers'),
    listTrustedPeers: () => ipcRenderer.invoke('v2:list-trusted-peers'),
    revokeTrustedPeer: (deviceId) => ipcRenderer.invoke('v2:revoke-trusted-peer', deviceId),
    updateTrustedPeerDisplayName: (deviceId, displayName) =>
      ipcRenderer.invoke('v2:update-trusted-peer-display-name', deviceId, displayName),
    updateTrustedPeerPermissions: (deviceId, permissions) =>
      ipcRenderer.invoke('v2:update-trusted-peer-permissions', deviceId, permissions),
    updateTrustedPeer: (deviceId, options) =>
      ipcRenderer.invoke('v2:update-trusted-peer', deviceId, options),
    listSessions: () => ipcRenderer.invoke('v2:list-pairing-sessions'),
    start: (request) => ipcRenderer.invoke('v2:start-network-pairing', request),
    confirm: (pairingId) => ipcRenderer.invoke('v2:confirm-network-pairing', pairingId),
    complete: (request) => ipcRenderer.invoke('v2:complete-network-pairing', request),
    cancel: (pairingId) => ipcRenderer.invoke('v2:cancel-network-pairing', pairingId)
  }),
  transferJobs: Object.freeze({
    list: () => ipcRenderer.invoke('v2:list-transfer-jobs'),
    pause: (taskId) => ipcRenderer.invoke('v2:pause-transfer-job', taskId),
    resume: (taskId) => ipcRenderer.invoke('v2:resume-transfer-job', taskId),
    retry: (taskId) => ipcRenderer.invoke('v2:retry-transfer-job', taskId),
    cancel: (taskId) => ipcRenderer.invoke('v2:cancel-transfer-job', taskId)
  }),
  library: Object.freeze({
    getStatus: () => ipcRenderer.invoke('v2:library-get-status'),
    listShares: () => ipcRenderer.invoke('v2:library-list-shares'),
    chooseShareDirectory: () => ipcRenderer.invoke('v2:library-choose-share-directory'),
    openShareDirectory: (shareId) => ipcRenderer.invoke('v2:library-open-share-directory', shareId),
    resetShareDirectory: () => ipcRenderer.invoke('v2:library-reset-share-directory')
  }),
  onState: (callback) => ipcRenderer.on('state', (_event, state) => callback(state)),
  onPeers: (callback) => ipcRenderer.on('peers', (_event, peers) => callback(peers)),
  onV2Peers: (callback) => ipcRenderer.on('v2-peers', (_event, peers) => callback(peers)),
  onV2PairingSession: (callback) => ipcRenderer.on('v2-pairing-session', (_event, session) => callback(session)),
  onTransferEvent: (callback) => ipcRenderer.on('transfer-event', (_event, transfer) => callback(transfer))
});

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('lanTransfer', {
  getState: () => ipcRenderer.invoke('get-state'),
  chooseSaveDirectory: () => ipcRenderer.invoke('choose-save-directory'),
  resetSaveDirectory: () => ipcRenderer.invoke('reset-save-directory'),
  refreshPeers: () => ipcRenderer.invoke('refresh-peers'),
  chooseFile: () => ipcRenderer.invoke('choose-file'),
  selectDroppedFile: (file) => ipcRenderer.invoke('select-dropped-file', webUtils.getPathForFile(file)),
  sendSelectedFileToPeer: (deviceId) => ipcRenderer.invoke('send-selected-file-to-peer', deviceId),
  chooseAndSend: (deviceId) => ipcRenderer.invoke('choose-and-send', deviceId),
  pairing: Object.freeze({
    listDiscoveredPeers: () => ipcRenderer.invoke('v2:list-discovered-peers'),
    listTrustedPeers: () => ipcRenderer.invoke('v2:list-trusted-peers'),
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
  onState: (callback) => ipcRenderer.on('state', (_event, state) => callback(state)),
  onPeers: (callback) => ipcRenderer.on('peers', (_event, peers) => callback(peers)),
  onV2Peers: (callback) => ipcRenderer.on('v2-peers', (_event, peers) => callback(peers)),
  onV2PairingSession: (callback) => ipcRenderer.on('v2-pairing-session', (_event, session) => callback(session)),
  onTransferEvent: (callback) => ipcRenderer.on('transfer-event', (_event, transfer) => callback(transfer))
});

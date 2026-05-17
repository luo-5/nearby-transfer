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
  onState: (callback) => ipcRenderer.on('state', (_event, state) => callback(state)),
  onPeers: (callback) => ipcRenderer.on('peers', (_event, peers) => callback(peers)),
  onTransferEvent: (callback) => ipcRenderer.on('transfer-event', (_event, transfer) => callback(transfer))
});

const { app, BrowserWindow, dialog, ipcMain, Menu } = require('electron');
const fs = require('fs');
const path = require('path');
const { loadOrCreateDevice, updateDeviceConfig, toPublicDevice } = require('./core/config');
const { Discovery } = require('./core/discovery');
const { TransferServer } = require('./core/server');
const { sendFile } = require('./core/transfer');

let mainWindow = null;
let device = null;
let discovery = null;
let transferServer = null;
let saveDirectory = null;
let selectedFilePath = null;

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  createWindow();
  await startCore();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
      emitState();
    }
  });
}).catch((error) => {
  dialog.showErrorBox('附近传输启动失败', error.stack || error.message);
  app.quit();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  if (discovery) {
    discovery.stop();
  }
  if (transferServer) {
    transferServer.stop();
  }
});

ipcMain.handle('get-state', () => buildState());

ipcMain.handle('choose-save-directory', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择接收文件保存位置',
    defaultPath: saveDirectory || app.getPath('downloads'),
    properties: ['openDirectory', 'createDirectory']
  });
  if (result.canceled || result.filePaths.length === 0) {
    return { ok: false, cancelled: true };
  }

  try {
    setSaveDirectory(result.filePaths[0], true);
    emitState();
    return { ok: true, saveDirectory, saveDirectoryMode: getSaveDirectoryMode() };
  } catch (error) {
    return { ok: false, error: toUserError(error.message) };
  }
});

ipcMain.handle('reset-save-directory', () => {
  try {
    setSaveDirectory(getDefaultSaveDirectory(), true);
    emitState();
    return { ok: true, saveDirectory, saveDirectoryMode: getSaveDirectoryMode() };
  } catch (error) {
    return { ok: false, error: toUserError(error.message) };
  }
});

ipcMain.handle('refresh-peers', () => {
  if (discovery) {
    discovery.announce();
  }
  return discovery ? discovery.listPeers() : [];
});

ipcMain.handle('choose-file', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择要发送的文件',
    properties: ['openFile']
  });
  if (result.canceled || result.filePaths.length === 0) {
    return { ok: false, cancelled: true };
  }

  const description = await describeFileForRenderer(result.filePaths[0]);
  if (description.ok) {
    selectedFilePath = description.file.path;
    return publicSelectedFileResult(description);
  }
  return description;
});

ipcMain.handle('select-dropped-file', async (_event, filePath) => {
  const description = await describeFileForRenderer(filePath);
  if (description.ok) {
    selectedFilePath = description.file.path;
    return publicSelectedFileResult(description);
  }
  return description;
});

ipcMain.handle('send-selected-file-to-peer', async (_event, deviceId) => sendFileToPeer(deviceId, selectedFilePath));

ipcMain.handle('choose-and-send', async (_event, deviceId) => {
  if (!device || !discovery) {
    return { ok: false, error: '应用还未准备好' };
  }

  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择要发送的文件',
    properties: ['openFile']
  });
  if (result.canceled || result.filePaths.length === 0) {
    return { ok: false, cancelled: true };
  }

  selectedFilePath = result.filePaths[0];
  return sendFileToPeer(deviceId, selectedFilePath);
});

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1040,
    height: 720,
    minWidth: 860,
    minHeight: 560,
    title: '附近传输',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.removeMenu();
  mainWindow.setMenuBarVisibility(false);
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== mainWindow.webContents.getURL()) {
      event.preventDefault();
    }
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

async function describeFileForRenderer(filePath) {
  if (!filePath || typeof filePath !== 'string') {
    return { ok: false, error: '未选择文件' };
  }

  try {
    const stat = await require('fs').promises.stat(filePath);
    if (!stat.isFile()) {
      return { ok: false, error: '只能发送普通文件' };
    }
    return {
      ok: true,
      file: {
        path: filePath,
        name: path.basename(filePath),
        size: stat.size
      }
    };
  } catch (error) {
    return { ok: false, error: toUserError(error.message) };
  }
}

function publicSelectedFileResult(description) {
  return {
    ok: true,
    file: {
      name: description.file.name,
      size: description.file.size
    }
  };
}

async function sendFileToPeer(deviceId, filePath) {
  if (!device || !discovery) {
    return { ok: false, error: '应用还未准备好' };
  }
  if (!deviceId || typeof deviceId !== 'string') {
    return { ok: false, error: '请先选择设备' };
  }
  if (!filePath || typeof filePath !== 'string') {
    return { ok: false, error: '请先选择文件' };
  }

  const peer = discovery.getPeer(deviceId);
  if (!peer) {
    return { ok: false, error: '设备已离线' };
  }

  try {
    const transferResult = await sendFile({
      peer,
      filePath,
      device,
      onTransferEvent: emitTransferEvent
    });
    return { ok: true, result: transferResult };
  } catch (error) {
    if (error.message === 'Receiver rejected the transfer') {
      return { ok: false, error: toUserError(error.message) };
    }
    emitTransferEvent({
      transferId: 'send-error',
      direction: 'send',
      status: 'failed',
      peer,
      file: { name: path.basename(filePath), size: 0 },
      bytes: 0,
      total: 0,
      error: toUserError(error.message)
    });
    return { ok: false, error: toUserError(error.message) };
  }
}

async function startCore() {
  device = loadOrCreateDevice(app.getPath('userData'));
  setSaveDirectory(device.saveDirectory || app.getPath('downloads'), false);
  transferServer = new TransferServer({
    device,
    saveDirectory,
    onIncomingRequest: confirmIncomingTransfer,
    onTransferEvent: emitTransferEvent
  });
  const port = await transferServer.start(0);

  discovery = new Discovery({ device, port });
  discovery.on('peers', (peers) => sendToRenderer('peers', peers));
  discovery.on('error', (error) => emitTransferEvent({
    transferId: 'discovery-error',
    direction: 'system',
    status: 'failed',
    error: error.message
  }));
  discovery.start();
  emitState();
}

function setSaveDirectory(nextDirectory, persist) {
  if (!nextDirectory || typeof nextDirectory !== 'string') {
    throw new Error('Invalid save directory');
  }
  fs.mkdirSync(nextDirectory, { recursive: true });
  saveDirectory = nextDirectory;
  if (transferServer) {
    transferServer.setSaveDirectory(saveDirectory);
  }
  if (persist && device) {
    updateDeviceConfig(device, { saveDirectory });
  }
}

function getDefaultSaveDirectory() {
  return app.getPath('downloads');
}

function getSaveDirectoryMode() {
  const defaultDirectory = path.resolve(getDefaultSaveDirectory());
  const currentDirectory = path.resolve(saveDirectory || defaultDirectory);
  return currentDirectory === defaultDirectory ? '默认下载目录' : '自定义目录';
}

async function confirmIncomingTransfer(incoming) {
  const detail = [
    `发送方：${incoming.sender.deviceName}`,
    `指纹：${incoming.sender.fingerprint}`,
    `文件：${incoming.file.originalName || incoming.file.name}`,
    `大小：${formatBytes(incoming.file.size)}`,
    `保存到：${incoming.savePath}`
  ].join('\n');

  const result = await dialog.showMessageBox(mainWindow || undefined, {
    type: 'question',
    buttons: ['接收', '拒绝'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
    message: '接收这个文件吗？',
    detail
  });

  return { accepted: result.response === 0 };
}

function buildState() {
  return {
    device: device && transferServer ? toPublicDevice(device, transferServer.port) : null,
    saveDirectory,
    saveDirectoryMode: getSaveDirectoryMode(),
    peers: discovery ? discovery.listPeers() : []
  };
}

function emitState() {
  sendToRenderer('state', buildState());
}

function emitTransferEvent(event) {
  sendToRenderer('transfer-event', Object.assign({ timestamp: Date.now() }, event));
}

function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) {
    return '未知';
  }
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function toUserError(message) {
  const translations = new Map([
    ['Only regular files can be sent', '只能发送普通文件'],
    ['Missing target peer', '缺少目标设备'],
    ['Receiver rejected the transfer', '对方已拒绝接收'],
    ['Request timed out', '请求超时'],
    ['Upload timed out', '上传超时'],
    ['Peer returned invalid JSON', '对方返回了无效响应']
  ]);
  return translations.get(message) || message || '操作失败';
}

const { app, BrowserWindow, dialog, ipcMain, Menu, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { loadOrCreateDevice, updateDeviceConfig, toPublicDevice } = require('./core/config');
const { Discovery } = require('./core/discovery');
const { TransferServer } = require('./core/server');
const { ensureSafeDirectory, walkDirectory } = require('./core/path-utils');
const { sendFile } = require('./core/transfer');
const { TrustedPeerStore } = require('./v2/trusted-peer-store');
const { PairingSessionStore } = require('./v2/pairing-session-store');
const { createDesktopPairingApi, registerPairingIpcHandlers } = require('./v2/desktop-pairing-api');
const { LanService } = require('./v2/lan-service');
const { registerLanServiceIpcHandlers } = require('./v2/desktop-lan-api');
const { TransferJobStore } = require('./v2/transfer-job-store');
const { createDesktopTransferJobApi, registerTransferJobIpcHandlers } = require('./v2/desktop-transfer-job-api');
const { DesktopLibraryService } = require('./v2/desktop-library-service');
const { registerLibraryServiceIpcHandlers } = require('./v2/desktop-library-api');

let mainWindow = null;
let device = null;
let discovery = null;
let transferServer = null;
let trustedPeerStore = null;
let pairingSessionStore = null;
let transferJobStore = null;
let desktopPairingApi = null;
let desktopLibraryService = null;
let v2LanService = null;
let saveDirectory = null;
let selectedFilePath = null;
let selectedFilePaths = [];
const activeTransferControllers = new Map();
process.on('uncaughtException', (err) => {
  try {
    fs.writeFileSync(path.join(__dirname, '..', 'main_error.log'), 'UNCAUGHT: ' + (err.stack || err.message) + '\n', { flag: 'a' });
  } catch (_e) { }
});

process.on('unhandledRejection', (err) => {
  try {
    fs.writeFileSync(path.join(__dirname, '..', 'main_error.log'), 'UNHANDLED REJECTION: ' + (err ? (err.stack || err.message) : 'unknown') + '\n', { flag: 'a' });
  } catch (_e) { }
});

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
  try {
    fs.writeFileSync('main_error.log', (error.stack || error.message) + '\n', 'utf8');
  } catch (_e) { }
  console.error('MAIN ERROR:', error);
  dialog.showErrorBox('附近传输启动失败', error.stack || error.message);
  app.quit();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  if (desktopLibraryService) {
    desktopLibraryService.stop().catch(() => { });
    desktopLibraryService = null;
  }
  if (v2LanService) {
    v2LanService.stop().catch(() => { });
    v2LanService = null;
  }
  if (discovery) {
    discovery.stop();
  }
  if (transferServer) {
    transferServer.stop();
  }
  if (pairingSessionStore) {
    pairingSessionStore.close();
    pairingSessionStore = null;
  }
  if (transferJobStore) {
    transferJobStore.close();
    transferJobStore = null;
  }
  if (trustedPeerStore) {
    trustedPeerStore.close();
    trustedPeerStore = null;
  }
});

ipcMain.handle('get-state', () => buildState());

ipcMain.handle('choose-save-directory', async () => {
  const isZh = currentLanguage === 'zh';
  const result = await dialog.showOpenDialog(mainWindow, {
    title: isZh ? '选择接收文件保存位置' : 'Select Directory to Save Received Files',
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
  const isZh = currentLanguage === 'zh';
  const result = await dialog.showOpenDialog(mainWindow, {
    title: isZh ? '选择要发送的文件' : 'Select Files to Send',
    properties: ['openFile', 'multiSelections']
  });
  if (result.canceled || result.filePaths.length === 0) {
    return { ok: false, cancelled: true };
  }

  const validFiles = [];
  let totalSize = 0;
  for (const fp of result.filePaths) {
    try {
      const stat = await fs.promises.stat(fp);
      if (stat.isFile()) {
        validFiles.push({ path: fp, name: path.basename(fp), size: stat.size });
        totalSize += stat.size;
      }
    } catch (_) { }
  }
  if (validFiles.length === 0) {
    return { ok: false, error: '未找到有效文件' };
  }

  selectedFilePaths = validFiles.map(f => f.path);
  selectedFilePath = selectedFilePaths[0];
  if (validFiles.length === 1) {
    return {
      ok: true,
      file: { name: validFiles[0].name, size: validFiles[0].size, count: 1 }
    };
  }
  return {
    ok: true,
    file: {
      name: `已选择 ${validFiles.length} 个文件 (${validFiles[0].name} 等)`,
      size: totalSize,
      count: validFiles.length
    }
  };
});

let currentLanguage = 'zh';

ipcMain.on('set-language', (_event, lang) => {
  if (lang === 'en' || lang === 'zh') {
    currentLanguage = lang;
  }
});

ipcMain.handle('select-dropped-files', async (_event, filePaths) => {
  if (!Array.isArray(filePaths) || filePaths.length === 0) {
    return { ok: false, error: currentLanguage === 'zh' ? '未选择任何文件' : 'No files selected' };
  }
  const validFiles = [];
  let totalSize = 0;
  for (const fp of filePaths) {
    try {
      const stat = await fs.promises.stat(fp);
      if (stat.isDirectory()) {
        walkDirectory(fp, validFiles);
        totalSize = validFiles.reduce((sum, f) => sum + f.size, 0);
      } else if (stat.isFile()) {
        validFiles.push({ path: fp, name: path.basename(fp), size: stat.size });
        totalSize += stat.size;
      }
    } catch (_) { }
  }
  if (validFiles.length === 0) {
    return { ok: false, error: currentLanguage === 'zh' ? '所选路径中未包含有效文件' : 'No valid files found in selected paths' };
  }
  selectedFilePaths = validFiles.map(f => f.path);
  selectedFilePath = selectedFilePaths[0];
  if (validFiles.length === 1) {
    return {
      ok: true,
      file: { name: validFiles[0].name, size: validFiles[0].size, count: 1 }
    };
  }
  const isZh = currentLanguage === 'zh';
  return {
    ok: true,
    file: {
      name: isZh ? `已选择 ${validFiles.length} 个文件 (${validFiles[0].name} 等)` : `${validFiles.length} files selected (${validFiles[0].name}, etc.)`,
      size: totalSize,
      count: validFiles.length
    }
  };
});

ipcMain.handle('select-dropped-file', async (_event, filePath) => {
  if (!filePath) return { ok: false, error: '无效文件路径' };
  const description = await describeFileForRenderer(filePath);
  if (description.ok) {
    selectedFilePath = description.file.path;
    selectedFilePaths = [selectedFilePath];
    return publicSelectedFileResult(description);
  }
  return description;
});

ipcMain.handle('send-selected-file-to-peer', async (_event, deviceId) => {
  if (!selectedFilePaths || selectedFilePaths.length === 0) {
    if (selectedFilePath) selectedFilePaths = [selectedFilePath];
    else return { ok: false, error: '请先选择文件' };
  }
  let successCount = 0;
  let failCount = 0;
  let lastError = null;
  const total = selectedFilePaths.length;

  for (let i = 0; i < total; i++) {
    const fp = selectedFilePaths[i];
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('batch-progress', {
        current: i + 1,
        total,
        name: require('path').basename(fp)
      });
    }
    const result = await sendFileToPeer(deviceId, fp);
    if (result.ok) {
      successCount++;
    } else {
      failCount++;
      lastError = result.error;
    }
  }

  if (failCount === 0) {
    return { ok: true };
  } else if (successCount === 0) {
    return { ok: false, error: lastError || '全部文件发送失败' };
  } else {
    return { ok: false, error: `部分发送失败 (成功 ${successCount}，失败 ${failCount})` };
  }
});

ipcMain.handle('cancel-transfer', async (_event, transferId) => {
  let handled = false;
  const ctrl = activeTransferControllers.get(transferId);
  if (ctrl && typeof ctrl.cancel === 'function') {
    ctrl.cancel();
    activeTransferControllers.delete(transferId);
    handled = true;
  }
  if (transferServer && typeof transferServer.cancelTransfer === 'function') {
    if (transferServer.cancelTransfer(transferId)) {
      handled = true;
    }
  }
  if (handled) return { ok: true };
  return { ok: false, error: '未找到进行中的传输任务' };
});

ipcMain.handle('pause-transfer', async (_event, transferId) => {
  const ctrl = activeTransferControllers.get(transferId);
  if (ctrl && typeof ctrl.pause === 'function') {
    ctrl.pause();
    return { ok: true };
  }
  return { ok: false, error: '未找到进行中的传输任务' };
});

ipcMain.handle('resume-transfer', async (_event, transferId) => {
  const ctrl = activeTransferControllers.get(transferId);
  if (ctrl && typeof ctrl.resume === 'function') {
    ctrl.resume();
    return { ok: true };
  }
  return { ok: false, error: '未找到进行中的传输任务' };
});

ipcMain.handle('open-transfer-folder', async (_event, filePath) => {
  if (filePath && typeof filePath === 'string') {
    shell.showItemInFolder(filePath);
    return { ok: true };
  }
  return { ok: false, error: '文件路径无效' };
});

let currentTransferProtocol = 'v2-stream';

function loadProtocolConfig(userDataDir) {
  try {
    const file = path.join(userDataDir, 'protocol_config.json');
    if (fs.existsSync(file)) {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (data && data.protocol) {
        currentTransferProtocol = data.protocol;
      }
    }
  } catch (_) {}
}

function saveProtocolConfig(userDataDir, protocol) {
  try {
    const file = path.join(userDataDir, 'protocol_config.json');
    fs.writeFileSync(file, JSON.stringify({ protocol, updatedAt: Date.now() }, null, 2), 'utf8');
  } catch (_) {}
}

ipcMain.handle('get-protocol', async () => {
  return { protocol: currentTransferProtocol };
});

ipcMain.handle('set-protocol', async (_event, protocol) => {
  const allowed = [
    'v2-stream',
    'turbo-parallel',
    'quic-udp',
    'smb-share',
    'webdav-sync',
    'v1-classic',
    'ftps-secure'
  ];
  if (!allowed.includes(protocol)) {
    return { ok: false, error: 'Invalid protocol' };
  }
  currentTransferProtocol = protocol;
  try {
    const userDataDir = app.getPath('userData');
    saveProtocolConfig(userDataDir, protocol);
  } catch (_) {}
  return { ok: true, protocol: currentTransferProtocol };
});

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
    show: true,
    center: true,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
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
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    mainWindow.focus();
  });
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
      onTransferInit: (ctrl) => {
        activeTransferControllers.set(ctrl.transferId, ctrl);
      },
      onTransferEvent: (event) => {
        if (['completed', 'failed', 'cancelled', 'rejected'].includes(event.status)) {
          activeTransferControllers.delete(event.transferId);
        }
        emitTransferEvent(event);
      }
    });
    return { ok: true, result: transferResult };
  } catch (error) {
    if (error.message === 'Receiver rejected the transfer' || error.message === '用户已主动取消传输') {
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
  const userDataDir = app.getPath('userData');
  device = loadOrCreateDevice(userDataDir);
  trustedPeerStore = new TrustedPeerStore(userDataDir);
  pairingSessionStore = new PairingSessionStore(userDataDir);
  transferJobStore = new TransferJobStore(userDataDir, trustedPeerStore);
  loadProtocolConfig(userDataDir);

  const defaultShareDir = path.join(userDataDir, 'SharedLibrary');
  if (!fs.existsSync(defaultShareDir)) {
    fs.mkdirSync(defaultShareDir, { recursive: true });
    fs.writeFileSync(
      path.join(defaultShareDir, '欢迎使用附近传输-共享库.txt'),
      '恭喜！您已成功连接到电脑端受控 NAS 共享文件库。\n您可以在手机上随时下载此文件，也可以从手机上传相片和文档！\n',
      'utf8'
    );
  }

  let activeShareDir = defaultShareDir;
  try {
    const configFile = path.join(userDataDir, 'library_config.json');
    if (fs.existsSync(configFile)) {
      const parsed = JSON.parse(fs.readFileSync(configFile, 'utf8'));
      if (parsed && typeof parsed.activeSharePath === 'string' && fs.existsSync(parsed.activeSharePath)) {
        activeShareDir = parsed.activeSharePath;
      }
    }
  } catch (_e) { }

  desktopLibraryService = new DesktopLibraryService({
    trustedPeerStore,
    shares: [{
      id: 'default-share',
      name: '电脑共享文件库',
      localPath: activeShareDir,
      readOnly: false
    }]
  });
  registerLibraryServiceIpcHandlers(ipcMain, desktopLibraryService, { dialog, shell, userDataDir });
  let libraryPort = 56578;
  try {
    libraryPort = await desktopLibraryService.start(56578);
  } catch (_e) {
    libraryPort = await desktopLibraryService.start(0);
  }

  desktopPairingApi = createDesktopPairingApi({ device, trustedPeerStore, pairingSessionStore });
  registerPairingIpcHandlers(ipcMain, desktopPairingApi);
  v2LanService = new LanService({ device, pairingApi: desktopPairingApi, capabilities: ['pairing', 'transfer', 'library'], enableDiscovery: true });
  v2LanService.on('peers', (peers) => sendToRenderer('v2-peers', peers.map(toPublicV2Peer)));
  v2LanService.on('pairing-session', (session) => sendToRenderer('v2-pairing-session', session));
  v2LanService.on('error', (error) => emitTransferEvent({
    transferId: 'v2-discovery-error', direction: 'system', status: 'failed', error: error.message
  }));
  v2LanService.on('protocol-error', ({ error }) => emitTransferEvent({
    transferId: 'v2-protocol-error', direction: 'system', status: 'failed', error: 'v2 pairing message rejected: ' + error.message
  }));
  registerLanServiceIpcHandlers(ipcMain, v2LanService);
  registerTransferJobIpcHandlers(
    ipcMain,
    createDesktopTransferJobApi({ transferJobStore })
  );
  initializeSaveDirectory();
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
  const v2Port = await v2LanService.start();

  try {
    fs.writeFileSync('running_ports.json', JSON.stringify({
      libraryPort,
      transferServerPort: port,
      v2LanPort: v2Port
    }, null, 2), 'utf8');
  } catch (_e) { }

  emitState();
}

function toPublicV2Peer(peer) {
  return {
    deviceId: peer.deviceId,
    deviceName: peer.deviceName,
    fingerprint: peer.fingerprint,
    capabilities: Array.isArray(peer.capabilities) ? peer.capabilities.slice() : [],
    lastSeen: peer.lastSeen
  };
}

function initializeSaveDirectory() {
  const preferredDirectory = device.saveDirectory || getDefaultSaveDirectory();
  try {
    setSaveDirectory(preferredDirectory, false);
  } catch (error) {
    const fallbackDirectory = getDefaultSaveDirectory();
    setSaveDirectory(fallbackDirectory, false);
    emitTransferEvent({
      transferId: 'save-directory-recovery',
      direction: 'system',
      status: 'failed',
      error: '保存目录不可用，已临时切换到默认下载目录：' + toUserError(error.message)
    });
  }
}

function setSaveDirectory(nextDirectory, persist) {
  const resolvedDirectory = ensureSafeDirectory(nextDirectory);
  saveDirectory = resolvedDirectory;
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
  const isZh = currentLanguage === 'zh';
  const defaultDirectory = path.resolve(getDefaultSaveDirectory());
  const currentDirectory = path.resolve(saveDirectory || defaultDirectory);
  return currentDirectory === defaultDirectory ? (isZh ? '默认下载目录' : 'Default Downloads Folder') : (isZh ? '自定义目录' : 'Custom Folder');
}

async function confirmIncomingTransfer(incoming) {
  const isZh = currentLanguage === 'zh';
  const detail = isZh ? [
    `发送方：${incoming.sender.deviceName}`,
    `指纹：${incoming.sender.fingerprint}`,
    `文件：${incoming.file.originalName || incoming.file.name}`,
    `大小：${formatBytes(incoming.file.size)}`,
    `保存到：${incoming.savePath}`
  ].join('\n') : [
    `Sender: ${incoming.sender.deviceName}`,
    `Fingerprint: ${incoming.sender.fingerprint}`,
    `File: ${incoming.file.originalName || incoming.file.name}`,
    `Size: ${formatBytes(incoming.file.size)}`,
    `Save to: ${incoming.savePath}`
  ].join('\n');

  const result = await dialog.showMessageBox(mainWindow || undefined, {
    type: 'question',
    buttons: isZh ? ['接收', '拒绝'] : ['Accept', 'Reject'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
    message: isZh ? '接收这个文件吗？' : 'Accept this file?',
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
    ['Peer returned invalid JSON', '对方返回了无效响应'],
    ['Invalid directory', '保存目录无效'],
    ['Directory must be absolute', '保存目录必须是绝对路径'],
    ['Directory path must point to a directory', '保存路径必须是目录'],
    ['Directory path must not be a symbolic link', '保存目录不能是符号链接'],
    ['Directory path must resolve to itself', '保存目录不能通过链接跳转']
  ]);
  return translations.get(message) || message || '操作失败';
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 980,
    height: 720,
    minWidth: 800,
    minHeight: 600,
    show: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

'use strict';

const path = require('path');
const fs = require('fs');

function registerLibraryServiceIpcHandlers(ipcMain, libraryService, { dialog, shell, userDataDir, getLanIp } = {}) {
  if (!ipcMain || typeof ipcMain.handle !== 'function') throw new TypeError('ipcMain.handle is required');
  if (!libraryService) throw new TypeError('A library service is required');

  const defaultDir = userDataDir ? path.join(userDataDir, 'SharedLibrary') : null;

  ipcMain.handle('v2:library-get-status', () => {
    const status = libraryService.getStatus();
    const shares = libraryService.listShares();
    const primaryShare = shares.find(s => s.id === 'default-share') || shares[0] || null;
    const ip = typeof getLanIp === 'function' ? getLanIp() : '127.0.0.1';
    return {
      ...status,
      shares,
      primaryShare,
      isDefault: primaryShare ? (defaultDir && path.resolve(primaryShare.localPath) === path.resolve(defaultDir)) : true,
      webDavUrl: status.port ? `http://${ip}:${status.port}/webdav/default-share` : null
    };
  });

  ipcMain.handle('v2:library-list-shares', () => {
    return libraryService.listShares();
  });

  function persistLibraryConfig(localPath, writable) {
    if (!userDataDir) return;
    try {
      const configFile = path.join(userDataDir, 'library_config.json');
      fs.writeFileSync(configFile, JSON.stringify({
        activeSharePath: localPath,
        // Write access is an explicit user opt-in, never a default.
        writable: writable === true,
        updatedAt: Date.now()
      }, null, 2), 'utf8');
    } catch (_e) {}
  }

  ipcMain.handle('v2:library-choose-share-directory', async () => {
    if (!dialog) return { ok: false, error: 'Dialog not available' };
    const shares = libraryService.listShares();
    const current = shares.find(s => s.id === 'default-share') || shares[0];
    const defaultPath = current ? current.localPath : (defaultDir || process.cwd());

    const result = await dialog.showOpenDialog({
      title: '选择 NAS 共享文件库目录',
      defaultPath,
      properties: ['openDirectory', 'createDirectory']
    });

    if (result.canceled || result.filePaths.length === 0) {
      return { ok: false, cancelled: true };
    }

    const chosenPath = result.filePaths[0];
    libraryService.addShare({
      id: 'default-share',
      name: '电脑共享文件库',
      localPath: chosenPath,
      // Actively choosing a share directory is the explicit opt-in to uploads.
      readOnly: false
    });
    persistLibraryConfig(chosenPath, true);

    return {
      ok: true,
      localPath: chosenPath,
      isDefault: defaultDir ? path.resolve(chosenPath) === path.resolve(defaultDir) : false,
      shares: libraryService.listShares()
    };
  });

  ipcMain.handle('v2:library-open-share-directory', async (_event, shareId = 'default-share') => {
    const shares = libraryService.listShares();
    const target = shares.find(s => s.id === shareId) || shares[0];
    if (!target || !target.localPath) {
      return { ok: false, error: 'Share directory not found' };
    }
    if (!fs.existsSync(target.localPath)) {
      fs.mkdirSync(target.localPath, { recursive: true });
    }
    if (shell && typeof shell.openPath === 'function') {
      await shell.openPath(target.localPath);
      return { ok: true, path: target.localPath };
    }
    return { ok: false, error: 'Shell openPath not available' };
  });

  ipcMain.handle('v2:library-reset-share-directory', async () => {
    if (!defaultDir) return { ok: false, error: 'Default directory unknown' };
    if (!fs.existsSync(defaultDir)) {
      fs.mkdirSync(defaultDir, { recursive: true });
    }
    libraryService.addShare({
      id: 'default-share',
      name: '电脑共享文件库',
      localPath: defaultDir,
      readOnly: true
    });
    persistLibraryConfig(defaultDir, false);
    return {
      ok: true,
      localPath: defaultDir,
      isDefault: true,
      shares: libraryService.listShares()
    };
  });

  ipcMain.handle('v2:library-add-share', (_event, shareConfig) => {
    libraryService.addShare(shareConfig);
    return libraryService.listShares();
  });

  ipcMain.handle('v2:library-remove-share', (_event, shareId) => {
    const success = libraryService.removeShare(shareId);
    return { success, shares: libraryService.listShares() };
  });

  ipcMain.handle('v2:library-start', async (_event, port) => {
    const activePort = await libraryService.start(port || 0);
    return { port: activePort, status: libraryService.getStatus() };
  });

  ipcMain.handle('v2:library-stop', async () => {
    await libraryService.stop();
    return { status: libraryService.getStatus() };
  });

  ipcMain.handle('v2:library-create-session-token', (_event, { peerDeviceId, ttlMs }) => {
    const token = libraryService.createSessionToken(peerDeviceId, ttlMs);
    return { token };
  });
}

module.exports = {
  registerLibraryServiceIpcHandlers
};

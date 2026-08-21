'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { registerLibraryServiceIpcHandlers } = require('../src/v2/desktop-library-api');

async function testDesktopLibraryApiHandlers() {
  const handlers = new Map();
  const mockIpcMain = {
    handle(channel, fn) {
      handlers.set(channel, fn);
    }
  };

  const tempUserData = path.join(os.tmpdir(), 'nearby-lib-api-test-' + Date.now());
  fs.mkdirSync(tempUserData, { recursive: true });

  const customShareDir = path.join(tempUserData, 'CustomShare');
  fs.mkdirSync(customShareDir, { recursive: true });

  let openedPaths = [];
  const mockShell = {
    openPath: async (p) => {
      openedPaths.push(p);
      return '';
    }
  };

  const mockDialog = {
    showOpenDialog: async (opts) => {
      return { canceled: false, filePaths: [customShareDir] };
    }
  };

  const mockLibraryService = {
    shares: [{ id: 'default-share', name: '电脑共享文件库', localPath: path.join(tempUserData, 'SharedLibrary') }],
    getStatus() {
      return { ok: true, isListening: true, port: 56578 };
    },
    listShares() {
      return this.shares;
    },
    addShare(share) {
      const idx = this.shares.findIndex(s => s.id === share.id);
      if (idx >= 0) {
        this.shares[idx] = share;
      } else {
        this.shares.push(share);
      }
      return share;
    }
  };

  registerLibraryServiceIpcHandlers(mockIpcMain, mockLibraryService, {
    dialog: mockDialog,
    shell: mockShell,
    userDataDir: tempUserData,
    getLanIp: () => '192.168.1.100'
  });

  assert(handlers.has('v2:library-get-status'), 'Must register v2:library-get-status');
  assert(handlers.has('v2:library-choose-share-directory'), 'Must register v2:library-choose-share-directory');
  assert(handlers.has('v2:library-open-share-directory'), 'Must register v2:library-open-share-directory');
  assert(handlers.has('v2:library-reset-share-directory'), 'Must register v2:library-reset-share-directory');

  // Test get-status
  const statusRes = handlers.get('v2:library-get-status')();
  assert.strictEqual(statusRes.ok, true);
  assert.strictEqual(statusRes.port, 56578);
  assert.strictEqual(statusRes.webDavUrl, 'http://192.168.1.100:56578/webdav/default-share');

  // Test open-share-directory
  const openRes = await handlers.get('v2:library-open-share-directory')();
  assert.strictEqual(openRes.ok, true);
  assert(openedPaths.length > 0, 'shell.openPath should be invoked');

  // Test choose-share-directory
  const chooseRes = await handlers.get('v2:library-choose-share-directory')();
  assert.strictEqual(chooseRes.ok, true);
  assert.strictEqual(chooseRes.localPath, customShareDir);
  assert.strictEqual(mockLibraryService.shares[0].localPath, customShareDir);

  // Test reset-share-directory
  const resetRes = await handlers.get('v2:library-reset-share-directory')();
  assert.strictEqual(resetRes.ok, true);
  assert.strictEqual(mockLibraryService.shares[0].localPath, path.join(tempUserData, 'SharedLibrary'));

  // Clean up
  try { fs.rmSync(tempUserData, { recursive: true, force: true }); } catch (_) {}

  console.log('desktop-library-api smoke test passed');
}

testDesktopLibraryApiHandlers().catch((err) => {
  console.error(err);
  process.exit(1);
});

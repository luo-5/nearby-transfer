'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const { DesktopLibraryService } = require('../src/v2/desktop-library-service');
const { registerLibraryServiceIpcHandlers } = require('../src/v2/desktop-library-api');

class MockTrustedPeerStore {
  getTrustedPeer(deviceId) {
    return {
      deviceId,
      displayName: 'Phone Test Device',
      permissions: { transfer: true, libraryRead: true, libraryUpload: true },
      revokedAt: null,
      isTrusted: () => true
    };
  }
}

class MockIpcMain {
  constructor() {
    this.handlers = new Map();
  }
  handle(channel, fn) {
    this.handlers.set(channel, fn);
  }
  async invoke(channel, ...args) {
    const fn = this.handlers.get(channel);
    if (!fn) throw new Error(`No handler for channel ${channel}`);
    return fn({ sender: null }, ...args);
  }
}

function httpReq(options, postData) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    if (postData) req.write(postData);
    req.end();
  });
}

async function runTest() {
  console.log('====================================================');
  console.log('  TESTING DYNAMIC SHARED DIRECTORY SWITCH & ACCESS  ');
  console.log('====================================================');

  const baseDir = path.join(process.cwd(), 'temp_test_shares');
  const dirA = path.join(baseDir, 'share_A');
  const dirB = path.join(baseDir, 'share_B');

  if (fs.existsSync(baseDir)) fs.rmSync(baseDir, { recursive: true, force: true });
  fs.mkdirSync(dirA, { recursive: true });
  fs.mkdirSync(dirB, { recursive: true });

  fs.writeFileSync(path.join(dirA, 'file_in_A.txt'), 'Content in Share A', 'utf8');
  fs.writeFileSync(path.join(dirB, 'file_in_B.txt'), 'Content in Share B', 'utf8');

  const peerStore = new MockTrustedPeerStore();
  const libraryService = new DesktopLibraryService({
    trustedPeerStore: peerStore,
    shares: [{
      id: 'default-share',
      name: '电脑共享文件库',
      localPath: dirA,
      readOnly: false
    }]
  });

  const port = await libraryService.start(0);
  console.log(`[+] WebDAV service started on port ${port} with Dir A: ${dirA}`);

  const ipcMain = new MockIpcMain();
  const mockDialog = {
    showOpenDialog: async () => ({ canceled: false, filePaths: [dirB] })
  };

  registerLibraryServiceIpcHandlers(ipcMain, libraryService, {
    dialog: mockDialog,
    userDataDir: baseDir
  });

  const token = libraryService.createSessionToken('415847b501f88dbb');

  console.log('\n--- 1. Testing Dir A listing before switch ---');
  let resA = await httpReq({
    hostname: '127.0.0.1',
    port,
    path: '/webdav/default-share',
    method: 'PROPFIND',
    headers: { 'Authorization': `Bearer ${token}`, 'Depth': '1' }
  });
  console.log('Status code:', resA.statusCode);
  if (!resA.body.includes('file_in_A.txt')) throw new Error('file_in_A.txt should be in Dir A listing!');
  if (resA.body.includes('file_in_B.txt')) throw new Error('file_in_B.txt must NOT be in Dir A listing!');
  console.log('[PASS] Dir A listing correctly contains only file_in_A.txt');

  console.log('\n--- 2. Downloading file from Dir A ---');
  let dlA = await httpReq({
    hostname: '127.0.0.1',
    port,
    path: '/webdav/default-share/file_in_A.txt',
    method: 'GET',
    headers: { 'Authorization': `Bearer ${token}` }
  });
  console.log('Status code:', dlA.statusCode, 'Body:', dlA.body.trim());
  if (dlA.body.trim() !== 'Content in Share A') throw new Error('Failed to download file_in_A.txt correctly');
  console.log('[PASS] File A downloaded successfully');

  console.log('\n--- 3. Switching shared directory to Dir B via IPC ---');
  const switchRes = await ipcMain.invoke('v2:library-choose-share-directory');
  console.log('Switch result:', switchRes);
  if (!switchRes.ok || switchRes.localPath !== dirB) throw new Error('IPC failed to switch to Dir B');

  console.log('\n--- 4. Testing Dir B listing after switch ---');
  let resB = await httpReq({
    hostname: '127.0.0.1',
    port,
    path: '/webdav/default-share',
    method: 'PROPFIND',
    headers: { 'Authorization': `Bearer ${token}`, 'Depth': '1' }
  });
  console.log('Status code:', resB.statusCode);
  if (resB.body.includes('file_in_A.txt')) throw new Error('FATAL: Old file_in_A.txt is still listed after switching to Dir B!');
  if (!resB.body.includes('file_in_B.txt')) throw new Error('FATAL: New file_in_B.txt is not found in Dir B listing!');
  console.log('[PASS] Dir B listing immediately updated and contains only file_in_B.txt!');

  console.log('\n--- 5. Verifying old file from Dir A cannot be downloaded anymore ---');
  let dlOld = await httpReq({
    hostname: '127.0.0.1',
    port,
    path: '/webdav/default-share/file_in_A.txt',
    method: 'GET',
    headers: { 'Authorization': `Bearer ${token}` }
  });
  console.log('Download old file status code:', dlOld.statusCode);
  if (dlOld.statusCode !== 404) throw new Error(`Expected 404 for old file, but got ${dlOld.statusCode}`);
  console.log('[PASS] Old file is correctly inaccessible (404 Not Found)!');

  console.log('\n--- 6. Verifying new file from Dir B can be downloaded ---');
  let dlNew = await httpReq({
    hostname: '127.0.0.1',
    port,
    path: '/webdav/default-share/file_in_B.txt',
    method: 'GET',
    headers: { 'Authorization': `Bearer ${token}` }
  });
  console.log('Download new file status code:', dlNew.statusCode, 'Body:', dlNew.body.trim());
  if (dlNew.body.trim() !== 'Content in Share B') throw new Error('Failed to download new file_in_B.txt');
  console.log('[PASS] New file downloaded successfully!');

  console.log('\n--- 7. Verifying persistence in library_config.json ---');
  const configFile = path.join(baseDir, 'library_config.json');
  if (!fs.existsSync(configFile)) throw new Error('library_config.json was not created!');
  const savedConfig = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  console.log('Saved config:', savedConfig);
  if (savedConfig.activeSharePath !== dirB) throw new Error('Saved config does not match Dir B!');
  console.log('[PASS] Config persisted successfully!');

  await libraryService.stop();
  fs.rmSync(baseDir, { recursive: true, force: true });
  console.log('\n====================================================');
  console.log('  ALL DYNAMIC DIRECTORY SWITCH TESTS PASSED (100%)  ');
  console.log('====================================================');
}

runTest().catch((err) => {
  console.error('[TEST FAILED]:', err);
  process.exit(1);
});

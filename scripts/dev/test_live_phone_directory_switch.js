'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { fingerprintFor } = require('../src/core/crypto');
const { LanService } = require('../src/v2/lan-service');
const { TrustedPeerStore } = require('../src/v2/trusted-peer-store');
const { PairingSessionStore } = require('../src/v2/pairing-session-store');
const { createDesktopPairingApi } = require('../src/v2/desktop-pairing-api');
const { DesktopLibraryService } = require('../src/v2/desktop-library-service');
const { registerLibraryServiceIpcHandlers } = require('../src/v2/desktop-library-api');
const crypto = require('crypto');

function createLocalDevice() {
  const signing = crypto.generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
  });
  const encryption = crypto.generateKeyPairSync('x25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
  });

  const deviceId = crypto.createHash('sha256').update(signing.publicKey).digest('hex').slice(0, 16);
  const fingerprint = fingerprintFor(signing.publicKey);

  return {
    deviceId,
    deviceName: 'Desktop Test Machine',
    fingerprint,
    signingPublicKey: signing.publicKey,
    signingPrivateKey: signing.privateKey,
    encryptionPublicKey: encryption.publicKey,
    encryptionPrivateKey: encryption.privateKey
  };
}

async function main() {
  const appDataDir = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'nearby-transfer');
  if (!fs.existsSync(appDataDir)) fs.mkdirSync(appDataDir, { recursive: true });

  const testDirA = path.join(appDataDir, 'TestDir_Alpha');
  const testDirB = path.join(appDataDir, 'TestDir_Beta');
  if (fs.existsSync(testDirA)) fs.rmSync(testDirA, { recursive: true, force: true });
  if (fs.existsSync(testDirB)) fs.rmSync(testDirB, { recursive: true, force: true });

  fs.mkdirSync(testDirA, { recursive: true });
  fs.mkdirSync(testDirB, { recursive: true });

  fs.writeFileSync(path.join(testDirA, '【Alpha库文件】旧共享数据.txt'), '这是 Alpha 目录下的内容\n', 'utf8');
  fs.writeFileSync(path.join(testDirB, '【Beta新库文件】新自定义目录.txt'), '这是 Beta 目录下的全新内容\n', 'utf8');
  fs.mkdirSync(path.join(testDirB, 'Beta_子文件夹'), { recursive: true });
  fs.writeFileSync(path.join(testDirB, 'Beta_子文件夹', '子项目文档.pdf'), 'FAKE_PDF_DATA', 'utf8');

  const localDevice = createLocalDevice();
  const peerStore = new TrustedPeerStore(appDataDir);
  const sessionStore = new PairingSessionStore(appDataDir);
  const pairingApi = createDesktopPairingApi({
    device: localDevice,
    trustedPeerStore: peerStore,
    pairingSessionStore: sessionStore
  });

  const lanService = new LanService({
    device: localDevice,
    pairingApi,
    capabilities: ['pairing', 'transfer', 'library'],
    enableDiscovery: true
  });

  const libraryService = new DesktopLibraryService({
    trustedPeerStore: peerStore,
    shares: [{
      id: 'default-share',
      name: '电脑共享文件库',
      localPath: testDirA,
      readOnly: false
    }]
  });

  const port = await libraryService.start(56578);
  console.log(`[+] NAS WebDAV Service running on port ${port} with Alpha Dir`);

  peerStore.database.prepare(`
    INSERT OR REPLACE INTO trusted_peers (
      device_id, display_name, fingerprint, public_key, permissions_json,
      last_transferred_at, updated_at, revoked_at, created_at
    ) VALUES (
      '415847b501f88dbb', 'Physical Android Phone', 'PHONE-FP',
      'FAKE_KEY', '{"transfer":true,"libraryRead":true,"libraryUpload":true}',
      ?, ?, NULL, ?
    )
  `).run(Date.now(), Date.now(), Date.now());

  await lanService.start(52530);
  console.log('Daemon ready on port 56578.');

  global.__test_switch_to_beta = () => {
    console.log('\n>>> SWITCHING ACTIVE SHARE TO BETA DIR: ' + testDirB);
    libraryService.addShare({
      id: 'default-share',
      name: '电脑共享文件库',
      localPath: testDirB,
      readOnly: false
    });
    console.log('[+] Share switched to Beta Dir! SSE broadcast sent.');
  };
}

main().catch(console.error);

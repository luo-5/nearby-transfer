'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { fingerprintFor } = require('../src/core/crypto');
const { LanService } = require('../src/v2/lan-service');
const { TrustedPeerStore } = require('../src/v2/trusted-peer-store');
const { PairingSessionStore } = require('../src/v2/pairing-session-store');
const { createDesktopPairingApi } = require('../src/v2/desktop-pairing-api');
const { DesktopLibraryService } = require('../src/v2/desktop-library-service');

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
  const localDevice = createLocalDevice();
  console.log('====================================================');
  console.log('      DESKTOP LIVE PAIRING & TRANSFER DAEMON        ');
  console.log('====================================================');
  console.log('Device Name :', localDevice.deviceName);
  console.log('Fingerprint :', localDevice.fingerprint);

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
    capabilities: ['pairing', 'transfer'],
    enableDiscovery: true
  });

  lanService.on('connection-error', (info) => console.log('[CONNECTION ERROR]:', info));
  lanService.on('protocol-error', (info) => {
    console.log('[PROTOCOL ERROR]:', info.remoteAddress, info.error.message, info.error.stack);
  });

  lanService.on('peer-discovered', (peer) => {
    console.log(`[+] Discovered Peer: ${peer.deviceName} at ${peer.host}:${peer.port}`);
  });

  lanService.on('session-updated', (session) => {
    console.log(`\n[>>> SESSION EVENT <<<] ID: ${session.pairingId}, Status: ${session.status}, Role: ${session.role}`);
    
    if (session.status === 'awaiting-local-confirmation') {
      console.log('----------------------------------------------------');
      console.log(`>>> 6-DIGIT PAIRING CODE: [ ${session.pairingCode} ] <<<`);
      console.log('----------------------------------------------------');
      console.log('Auto-confirming pairing from Desktop side...');
      try {
        lanService.confirmPairing(session.pairingId);
        console.log('Desktop side confirmed! Waiting for mobile confirmation...');
      } catch (err) {
        console.error('Confirm error:', err.message);
      }
    } else if (session.status === 'ready-to-trust') {
      console.log('----------------------------------------------------');
      console.log('>>> BOTH SIDES CONFIRMED! SAVING TRUST... <<<');
      console.log('----------------------------------------------------');
      try {
        lanService.completePairing(session.pairingId, {
          displayName: session.peerOffer ? session.peerOffer.identity.deviceName : 'Mobile Device',
          permissions: { transfer: true, libraryRead: true, libraryUpload: true }
        });
        console.log('>>> SUCCESS! DEVICE IS NOW PERMANENTLY TRUSTED! <<<');
      } catch (err) {
        console.error('Complete error:', err.message);
      }
    } else if (session.status === 'completed') {
      console.log('>>> SESSION STATUS: COMPLETED & ACTIVE <<<');
    }
  });

  const defaultShareDir = path.join(appDataDir, 'SharedLibrary');
  if (!fs.existsSync(defaultShareDir)) {
    fs.mkdirSync(defaultShareDir, { recursive: true });
    fs.writeFileSync(
      path.join(defaultShareDir, '欢迎使用附近传输-共享库.txt'),
      '恭喜！您已成功连接到电脑端受控 NAS 共享文件库。\n您可以在手机上随时下载此文件，也可以从手机上传相片和文档！\n',
      'utf8'
    );
    fs.writeFileSync(
      path.join(defaultShareDir, '电脑端说明文档.txt'),
      '这是一个测试共享文档。由电脑端通过 WebDAV 服务提供安全访问。\n',
      'utf8'
    );
  }

  peerStore.database.prepare(`
    INSERT OR REPLACE INTO trusted_peers (
      device_id, device_name, display_name, fingerprint, signing_public_key, encryption_public_key,
      transfer_allowed, library_read_allowed, library_upload_allowed, paired_at, last_seen, revoked_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 1, 1, 1, ?, ?, NULL, ?)
  `).run(
    '415847b501f88dbb',
    'iPhone 20 Pro Max',
    '我的手机',
    '4158-47B5-01F8-8DBB',
    'dummy-sign-key',
    'dummy-enc-key',
    Date.now(),
    Date.now(),
    Date.now()
  );

  const libraryService = new DesktopLibraryService({
    trustedPeerStore: peerStore,
    shares: [{
      id: 'default-share',
      name: '电脑共享文件库',
      localPath: defaultShareDir,
      readOnly: false
    }]
  });
  await libraryService.start(56578);
  console.log('[+] NAS WebDAV Service running on port 56578');

  const port = await lanService.start(52530);
  console.log(`LAN Service listening on port ${port}...`);
  console.log('Daemon running. Ready to pair with mobile phone!');
}

main().catch(console.error);

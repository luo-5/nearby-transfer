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
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nearby-transfer-pair-'));
  const localDevice = createLocalDevice();
  console.log('=== DESKTOP LOCAL IDENTITY ===');
  console.log('Device Name :', localDevice.deviceName);
  console.log('Fingerprint :', localDevice.fingerprint);

  const peerStore = new TrustedPeerStore(tempDir);
  const sessionStore = new PairingSessionStore(tempDir);
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

  lanService.on('session-updated', (session) => {
    console.log(`\n[SESSION UPDATE] Status: ${session.status}, Code: ${session.pairingCode}`);
    if (session.status === 'awaiting-local-confirmation') {
      console.log('\n======================================================');
      console.log(`>>> VERIFY 6-DIGIT PAIRING CODE: [ ${session.pairingCode} ] <<<`);
      console.log('======================================================');
      console.log('Auto-confirming pairing from Desktop side...');
      try {
        lanService.confirmPairing(session.pairingId);
        console.log('Desktop confirmed! Waiting for phone user to tap Confirm...');
      } catch (err) {
        console.error('Confirm error:', err.message);
      }
    } else if (session.status === 'ready-to-trust') {
      console.log('\n[+] Both sides confirmed! Completing pairing and saving trust...');
      try {
        lanService.completePairing(session.pairingId, {
          displayName: session.peerOffer ? session.peerOffer.identity.deviceName : 'Mobile Device',
          permissions: { transfer: true, libraryRead: true, libraryUpload: true }
        });
        console.log('>>> PAIRING SUCCEEDED & TRUST RECORD SAVED! <<<');
      } catch (err) {
        console.error('Complete error:', err.message);
      }
    }
  });

  const port = await lanService.start(52530);
  console.log(`LAN Service active on port ${port}. Waiting for mobile device...`);

  let targetPeer = null;
  for (let i = 0; i < 20; i++) {
    const peers = lanService.listPeers();
    if (peers.length > 0) {
      targetPeer = peers[0];
      break;
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  if (!targetPeer) {
    console.error('Target phone not found on LAN within 10s.');
    await lanService.stop();
    return;
  }

  console.log('\n[!] Found target peer:', targetPeer.deviceName, 'at', `${targetPeer.host}:${targetPeer.port}`);
  console.log('Initiating pairing request...');

  await lanService.startPairing(targetPeer);
  console.log('Offer sent. Waiting for exchange...');

  // Wait 15 seconds for user / mobile interaction
  await new Promise((r) => setTimeout(r, 15000));

  await lanService.stop();
  peerStore.close();
  sessionStore.close();
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
}

main().catch(console.error);

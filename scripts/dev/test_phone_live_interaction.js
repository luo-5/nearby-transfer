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

async function testLiveDiscovery() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nearby-transfer-live-'));
  console.log('=== STARTING LIVE MDNS / MULTICAST DISCOVERY SCAN ===');
  const localDevice = createLocalDevice();
  console.log('Desktop Local Identity:', {
    deviceId: localDevice.deviceId,
    deviceName: localDevice.deviceName,
    fingerprint: localDevice.fingerprint
  });

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

  lanService.on('peer-discovered', (peer) => {
    console.log('\n[+] >>> DISCOVERED REAL PEER ON LAN! <<<');
    console.log('  Device Name :', peer.deviceName);
    console.log('  Device ID   :', peer.deviceId);
    console.log('  Fingerprint :', peer.fingerprint);
    console.log('  Host IP     :', peer.host);
    console.log('  Port        :', peer.port);
    console.log('  Capabilities:', peer.capabilities);
  });

  lanService.on('peer-lost', (deviceId) => {
    console.log('\n[-] PEER LOST:', deviceId);
  });

  const port = await lanService.start(52530);
  console.log(`LAN Service listening on port ${port}`);
  console.log('Multicast discovery active on 239.255.77.77:47777...');
  console.log('Scanning for 6 seconds...');

  await new Promise((resolve) => setTimeout(resolve, 6000));

  console.log('\n=== CURRENT DISCOVERED PEERS LIST ===');
  const peers = lanService.listPeers();
  if (peers.length === 0) {
    console.log('No peers discovered.');
  } else {
    for (const p of peers) {
      console.log(`* ${p.deviceName} [${p.deviceId}] at ${p.host}:${p.port} (${p.capabilities.join(', ')})`);
    }
  }

  await lanService.stop();
  fs.rmSync(tempDir, { recursive: true, force: true });
  console.log('\nLAN service stopped cleanly.');
}

testLiveDiscovery().catch(console.error);

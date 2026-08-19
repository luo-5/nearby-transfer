'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { createKeyPair, createX25519KeyPair, fingerprintFor } = require('../src/core/crypto');
const { TrustedPeerStore } = require('../src/v2/trusted-peer-store');
const { PairingSessionStore } = require('../src/v2/pairing-session-store');
const { createDesktopPairingApi } = require('../src/v2/desktop-pairing-api');
const { LanService } = require('../src/v2/lan-service');
const { encodeWireFrame } = require('../src/v2/wire-frame');
const { APP_ID, PROTOCOL_VERSION, MESSAGE_TYPES } = require('../src/v2/constants');

function createDevice(name) {
  const signing = createKeyPair('ed25519');
  const encryption = createX25519KeyPair();
  return {
    deviceId: crypto.createHash('sha256').update(signing.publicKey).digest('hex').slice(0, 16),
    deviceName: name,
    fingerprint: fingerprintFor(signing.publicKey),
    signingPublicKey: signing.publicKey,
    signingPrivateKey: signing.privateKey,
    encryptionPublicKey: encryption.publicKey,
    encryptionPrivateKey: encryption.privateKey
  };
}

function createRuntime(dir, device) {
  const peers = new TrustedPeerStore(dir);
  const sessions = new PairingSessionStore(dir);
  const api = createDesktopPairingApi({ device, trustedPeerStore: peers, pairingSessionStore: sessions });
  const service = new LanService({ device, pairingApi: api, enableDiscovery: false, bootstrapTimeoutMs: 3000 });
  return { peers, sessions, api, service };
}

function waitFor(condition, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      try {
        const result = condition();
        if (result) return resolve(result);
        if (Date.now() >= deadline) return reject(new Error('Timed out waiting for LAN service state'));
        setTimeout(tick, 10);
      } catch (error) { reject(error); }
    };
    tick();
  });
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nearby-transfer-lan-service-'));
  let left;
  let right;
  try {
    const leftDevice = createDevice('Left desktop');
    const rightDevice = createDevice('Right phone');
    left = createRuntime(path.join(root, 'left'), leftDevice);
    right = createRuntime(path.join(root, 'right'), rightDevice);
    const leftPort = await left.service.start();
    const rightPort = await right.service.start();

    const started = await right.service.startPairing({
      deviceId: leftDevice.deviceId,
      host: '127.0.0.1',
      port: leftPort
    }, { capabilities: ['pairing', 'transfer'] });
    const leftSession = await waitFor(() => left.api.listPairingSessions()[0]);
    assert.strictEqual(leftSession.role, 'responder');
    assert.strictEqual(leftSession.peer.deviceId, rightDevice.deviceId);

    left.service.confirmPairing(leftSession.pairingId, { capabilities: ['pairing', 'transfer'] });
    const rightSession = await waitFor(() => right.api.listPairingSessions().find((session) => session.pairingId === started.pairingId && session.peer));
    assert.strictEqual(left.api.listPairingSessions()[0].pairingCode, rightSession.pairingCode);
    assert.strictEqual(rightSession.status, 'awaiting-local-confirmation');

    right.service.confirmPairing(started.pairingId, { capabilities: ['pairing', 'transfer'] });
    await waitFor(() => left.api.listPairingSessions()[0] && left.api.listPairingSessions()[0].status === 'ready-to-trust');
    await waitFor(() => right.api.listPairingSessions()[0] && right.api.listPairingSessions()[0].status === 'ready-to-trust');

    left.service.completePairing(started.pairingId, { permissions: { transfer: true } });
    right.service.completePairing(started.pairingId, { permissions: { transfer: true } });
    assert.strictEqual(left.api.listTrustedPeers()[0].deviceId, rightDevice.deviceId);
    assert.strictEqual(right.api.listTrustedPeers()[0].deviceId, leftDevice.deviceId);

    const attacker = net.createConnection({ host: '127.0.0.1', port: rightPort });
    await new Promise((resolve) => attacker.once('connect', resolve));
    attacker.write(encodeWireFrame({
      header: { app: APP_ID, protocolVersion: PROTOCOL_VERSION, type: MESSAGE_TYPES.TRANSFER_MANIFEST },
      payload: Buffer.from('{}')
    }));
    await new Promise((resolve) => attacker.once('close', resolve));
    assert.strictEqual(right.api.listTrustedPeers().length, 1, 'invalid bootstrap traffic must not mutate trust');
    console.log('v2 LAN service smoke tests passed');
  } finally {
    if (left) {
      await left.service.stop();
      left.sessions.close();
      left.peers.close();
    }
    if (right) {
      await right.service.stop();
      right.sessions.close();
      right.peers.close();
    }
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
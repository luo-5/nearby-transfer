const assert = require('assert');
const crypto = require('crypto');
const { Discovery } = require('../src/core/discovery');
const { fingerprintFor } = require('../src/core/crypto');

function createKeyPair(type) {
  return crypto.generateKeyPairSync(type, {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
  });
}

function deviceIdFor(signingPublicKey) {
  return crypto.createHash('sha256').update(signingPublicKey).digest('hex').slice(0, 16);
}

function createAnnouncement() {
  const signing = createKeyPair('ed25519');
  const encryption = createKeyPair('x25519');
  return {
    app: 'nearby-transfer',
    protocolVersion: 1,
    type: 'announce',
    deviceId: deviceIdFor(signing.publicKey),
    deviceName: 'Test sender',
    port: 47778,
    signingPublicKey: signing.publicKey,
    encryptionPublicKey: encryption.publicKey,
    fingerprint: fingerprintFor(signing.publicKey),
    timestamp: Date.now()
  };
}

function createDiscovery() {
  return new Discovery({
    device: { deviceId: 'local-device-id' },
    port: 47779
  });
}

function deliver(discovery, payload) {
  discovery._handleMessage(Buffer.from(JSON.stringify(payload)), { address: '127.0.0.1' });
}

function main() {
  const discovery = createDiscovery();
  const accepted = createAnnouncement();
  let peerEvents = 0;
  discovery.on('peer', () => { peerEvents += 1; });

  deliver(discovery, accepted);
  assert.strictEqual(peerEvents, 1);
  assert.deepStrictEqual(discovery.getPeer(accepted.deviceId).port, accepted.port);

  for (const invalidPayload of [
    null,
    [],
    Object.assign({}, accepted, { port: 0 }),
    Object.assign({}, accepted, { port: 65536 }),
    Object.assign({}, accepted, { port: '47778' }),
    Object.assign({}, accepted, { deviceName: 123 }),
    Object.assign({}, accepted, { fingerprint: '' })
  ]) {
    assert.doesNotThrow(() => deliver(discovery, invalidPayload));
    assert.strictEqual(peerEvents, 1);
  }

  assert.doesNotThrow(() => discovery._handleMessage(Buffer.from('null'), { address: '127.0.0.1' }));
  assert.strictEqual(peerEvents, 1);
}

main();

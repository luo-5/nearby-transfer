const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { createKeyPair, createX25519KeyPair, fingerprintFor } = require('./crypto');

const CONFIG_FILE = 'device.json';

function loadOrCreateDevice(userDataDir) {
  fs.mkdirSync(userDataDir, { recursive: true });
  const configPath = path.join(userDataDir, CONFIG_FILE);

  if (fs.existsSync(configPath)) {
    const device = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return Object.assign({}, device, { configPath });
  }

  const signing = createKeyPair('ed25519');
  const encryption = createX25519KeyPair();
  const deviceId = crypto.createHash('sha256').update(signing.publicKey).digest('hex').slice(0, 16);
  const device = {
    version: 1,
    deviceId,
    deviceName: os.hostname(),
    signingPublicKey: signing.publicKey,
    signingPrivateKey: signing.privateKey,
    encryptionPublicKey: encryption.publicKey,
    encryptionPrivateKey: encryption.privateKey,
    fingerprint: fingerprintFor(signing.publicKey)
  };

  fs.writeFileSync(configPath, JSON.stringify(device, null, 2), { mode: 0o600 });
  return Object.assign({}, device, { configPath });
}

function updateDeviceConfig(device, updates) {
  if (!device || !device.configPath) {
    throw new Error('Missing device config path');
  }
  const next = Object.assign({}, device, updates);
  const stored = Object.assign({}, next);
  delete stored.configPath;
  fs.writeFileSync(device.configPath, JSON.stringify(stored, null, 2), { mode: 0o600 });
  Object.assign(device, updates);
  return next;
}

function toPublicDevice(device, port) {
  return {
    deviceId: device.deviceId,
    deviceName: device.deviceName,
    fingerprint: device.fingerprint,
    signingPublicKey: device.signingPublicKey,
    encryptionPublicKey: device.encryptionPublicKey,
    port
  };
}

module.exports = {
  loadOrCreateDevice,
  updateDeviceConfig,
  toPublicDevice
};

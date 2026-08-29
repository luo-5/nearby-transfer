'use strict';
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const { fingerprintFor } = require('../src/core/crypto');

const dbPath = path.join(process.env.APPDATA, 'nearby-transfer', 'nearby-transfer-v2.sqlite');
console.log('Opening DB:', dbPath);
const db = new DatabaseSync(dbPath);

const signing = crypto.generateKeyPairSync('ed25519', {
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
});
const encryption = crypto.generateKeyPairSync('x25519', {
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
});

const deviceId = '415847b501f88dbb';
const fingerprint = fingerprintFor(signing.publicKey);

db.prepare(`
  INSERT OR REPLACE INTO trusted_peers (
    device_id, device_name, display_name, fingerprint, signing_public_key, encryption_public_key,
    transfer_allowed, library_read_allowed, library_upload_allowed, paired_at, last_seen, revoked_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, 1, 1, 1, ?, ?, NULL, ?)
`).run(
  deviceId,
  'iPhone 20 Pro Max',
  '我的手机',
  fingerprint,
  signing.publicKey,
  encryption.publicKey,
  Date.now(),
  Date.now(),
  Date.now()
);

console.log('[+] Successfully updated phone trust with valid cryptographic keys:');
console.log('    Device ID   :', deviceId);
console.log('    Fingerprint :', fingerprint);

const peers = db.prepare('SELECT device_id, device_name, fingerprint, transfer_allowed, library_read_allowed, library_upload_allowed FROM trusted_peers').all();
console.log('Trusted Peers in DB:', peers);

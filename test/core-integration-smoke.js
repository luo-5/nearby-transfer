'use strict';

/**
 * Integration test: verifies that @luo-5/core exports the same
 * protocol surface as the legacy src/v2/ and src/core/ modules, so the
 * desktop can switch imports gradually (strangler fig pattern).
 */

const assert = require('assert');
const core = require('@luo-5/core');

async function main() {
  // Constants match
  assert.equal(core.APP_ID, 'nearby-transfer');
  assert.equal(core.PROTOCOL_VERSION, 2);
  assert.equal(core.PAIRING_CODE_DIGITS, 6);

  // Canonical JSON matches
  assert.equal(core.canonicalJson({ b: 1, a: 2 }), '{"a":2,"b":1}');

  // Crypto works
  const ed = core.createKeyPair('ed25519');
  const deviceId = core.deriveDeviceId(ed.publicKey);
  assert.match(deviceId, /^[a-f0-9]{16}$/);
  const fingerprint = core.fingerprintFor(ed.publicKey);
  assert.match(fingerprint, /^[0-9A-F]{4}(?:-[0-9A-F]{4}){5}$/);

  // Session key derivation works
  const enc1 = core.createX25519KeyPair();
  const enc2 = core.createX25519KeyPair();
  const taskId = core.createTaskId();
  const manifestSha = require('crypto').createHash('sha256').update('m').digest('hex');
  const key1 = core.deriveSessionKey({
    localPrivateKeyPem: enc1.privateKey, remotePublicKeyPem: enc2.publicKey,
    senderDeviceId: 'a1b2c3d4e5f60718', receiverDeviceId: '0123456789abcdef',
    taskId, manifestSha256: manifestSha,
  });
  const key2 = core.deriveSessionKey({
    localPrivateKeyPem: enc2.privateKey, remotePublicKeyPem: enc1.publicKey,
    senderDeviceId: 'a1b2c3d4e5f60718', receiverDeviceId: '0123456789abcdef',
    taskId, manifestSha256: manifestSha,
  });
  // Both sides derive the same key (ECDH symmetry)
  assert.equal(key1.length, 32);
  assert.deepEqual(key1, key2);

  // Manifest creation works
  const manifest = core.createTransferManifest({
    entries: [
      { kind: 'directory', path: 'docs' },
      { kind: 'file', path: 'docs/readme.md', size: 0, sha256: require('crypto').createHash('sha256').digest('hex') },
    ],
  });
  assert.equal(manifest.totalFiles, 1);
  assert.equal(manifest.totalBytes, 0);

  // Wire frame round-trips
  const frame = core.encodeWireFrame({
    header: { app: 'nearby-transfer', protocolVersion: 2, type: 'pairing-offer' },
    payload: Buffer.from('test'),
  });
  const decoded = core.decodeWireFrame(frame);
  assert.equal(decoded.header.type, 'pairing-offer');
  assert.equal(decoded.payload.toString(), 'test');

  // Protocol engine works
  const engine = new core.ProtocolEngine();
  assert.equal(engine.listProtocols().length, 7);
  assert.equal(engine.activeProtocolId, 'v2-stream');

  // Transfer job store works (JSON-backed)
  const tmpDir = require('os').tmpdir() + '/nt-integration-' + Date.now();
  const store = new core.TransferJobStore(tmpDir, { getTrustedPeer: () => null });
  assert.equal(store.list().length, 0);
  store.close();

  console.log('core integration smoke test passed');
}

main().catch((error) => { console.error(error); process.exit(1); });

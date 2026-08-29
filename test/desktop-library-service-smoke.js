'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const crypto = require('crypto');
const { DesktopLibraryService } = require('../src/v2/desktop-library-service');

class MockTrustedPeerStore {
  constructor(peers = {}) {
    this.peers = new Map(Object.entries(peers));
  }

  getPeer(deviceId) {
    return this.peers.get(deviceId) || null;
  }
}

function httpRequest(options, body = null) {
  return new Promise((resolve, reject) => {
    options.rejectUnauthorized = false; // Allow self-signed cert in tests
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
          rawBody: Buffer.concat(chunks)
        });
      });
    });

    req.on('error', reject);
    if (body) {
      req.write(body);
    }
    req.end();
  });
}

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nearby-transfer-library-test-'));
  const shareADir = path.join(tempDir, 'shareA');
  const shareBDir = path.join(tempDir, 'shareB');
  fs.mkdirSync(shareADir);
  fs.mkdirSync(shareBDir);

  fs.writeFileSync(path.join(shareADir, 'hello.txt'), 'Hello WebDAV World');
  fs.mkdirSync(path.join(shareADir, 'subfolder'));
  fs.writeFileSync(path.join(shareADir, 'subfolder', 'nested.txt'), 'Nested Content');

  const peerStore = new MockTrustedPeerStore({
    'peer-read-only': {
      deviceId: 'peer-read-only',
      isTrusted: () => true,
      permissions: { libraryRead: true, libraryUpload: false, transfer: true }
    },
    'peer-full-access': {
      deviceId: 'peer-full-access',
      isTrusted: () => true,
      permissions: { libraryRead: true, libraryUpload: true, transfer: true }
    },
    'peer-no-access': {
      deviceId: 'peer-no-access',
      isTrusted: () => true,
      permissions: { libraryRead: false, libraryUpload: false, transfer: true }
    }
  });

  const service = new DesktopLibraryService({
    trustedPeerStore: peerStore,
    shares: [
      { id: 'docs', name: 'Documents', localPath: shareADir, readOnly: false },
      { id: 'readonly', name: 'ReadOnlyShare', localPath: shareBDir, readOnly: true }
    ]
  });

  const port = await service.start(0);
  assert.ok(port > 0, 'Service must bind to a dynamic port');
  assert.strictEqual(service.getStatus().running, true);
  assert.strictEqual(service.getStatus().shareCount, 2);

  try {
    const fullToken = service.createSessionToken('peer-full-access');
    const readToken = service.createSessionToken('peer-read-only');

    // 1. Unauthorized request
    const unauth = await httpRequest({
      hostname: '127.0.0.1',
      port,
      path: '/docs/',
      method: 'PROPFIND'
    });
    assert.strictEqual(unauth.statusCode, 401);

    // 2. PROPFIND on root
    const rootPropfind = await httpRequest({
      hostname: '127.0.0.1',
      port,
      path: '/',
      method: 'PROPFIND',
      headers: { Authorization: `Bearer ${readToken}` }
    });
    assert.strictEqual(rootPropfind.statusCode, 207);
    assert.ok(rootPropfind.body.includes('Documents'));
    assert.ok(rootPropfind.body.includes('ReadOnlyShare'));

    // 3. PROPFIND on share directory
    const sharePropfind = await httpRequest({
      hostname: '127.0.0.1',
      port,
      path: '/docs/',
      method: 'PROPFIND',
      headers: { Authorization: `Bearer ${readToken}` }
    });
    assert.strictEqual(sharePropfind.statusCode, 207);
    assert.ok(sharePropfind.body.includes('hello.txt'));
    assert.ok(sharePropfind.body.includes('subfolder'));

    // 4. GET file download
    const getRes = await httpRequest({
      hostname: '127.0.0.1',
      port,
      path: '/docs/hello.txt',
      method: 'GET',
      headers: { Authorization: `Bearer ${readToken}` }
    });
    assert.strictEqual(getRes.statusCode, 200);
    assert.strictEqual(getRes.body, 'Hello WebDAV World');

    // 5. PUT upload new file with full token
    const putRes = await httpRequest({
      hostname: '127.0.0.1',
      port,
      path: '/docs/newfile.txt',
      method: 'PUT',
      headers: { Authorization: `Bearer ${fullToken}` }
    }, 'Brand new uploaded file');
    assert.strictEqual(putRes.statusCode, 201);
    assert.strictEqual(fs.readFileSync(path.join(shareADir, 'newfile.txt'), 'utf8'), 'Brand new uploaded file');

    // 6. PUT overwrite existing file should fail with 412
    const putOverwrite = await httpRequest({
      hostname: '127.0.0.1',
      port,
      path: '/docs/hello.txt',
      method: 'PUT',
      headers: { Authorization: `Bearer ${fullToken}` }
    }, 'Malicious overwrite attempt');
    assert.strictEqual(putOverwrite.statusCode, 412);
    assert.strictEqual(fs.readFileSync(path.join(shareADir, 'hello.txt'), 'utf8'), 'Hello WebDAV World');

    // 7. PUT with read-only token should fail with 403
    const putReadOnly = await httpRequest({
      hostname: '127.0.0.1',
      port,
      path: '/docs/another.txt',
      method: 'PUT',
      headers: { Authorization: `Bearer ${readToken}` }
    }, 'Read only upload attempt');
    assert.strictEqual(putReadOnly.statusCode, 403);

    // 8. PUT into read-only share should fail with 403
    const putIntoReadOnlyShare = await httpRequest({
      hostname: '127.0.0.1',
      port,
      path: '/readonly/test.txt',
      method: 'PUT',
      headers: { Authorization: `Bearer ${fullToken}` }
    }, 'Upload into readonly share');
    assert.strictEqual(putIntoReadOnlyShare.statusCode, 403);

    // 9. Path traversal attempt must be blocked with 403
    const traversal = await httpRequest({
      hostname: '127.0.0.1',
      port,
      path: '/docs/../outside.txt',
      method: 'GET',
      headers: { Authorization: `Bearer ${readToken}` }
    });
    assert.strictEqual(traversal.statusCode, 403);

    // 10. Malformed percent-encoding must be rejected with 400 instead of hanging
    const badEncoding = await httpRequest({
      hostname: '127.0.0.1',
      port,
      path: '/docs/%zz',
      method: 'GET',
      headers: { Authorization: `Bearer ${readToken}` }
    });
    assert.strictEqual(badEncoding.statusCode, 400);

    await assertHandshake(port);
    await assertHandshakeRateLimit();

    console.log('desktop library service smoke tests passed');
  } finally {
    await service.stop();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function handshakeSignature(deviceId, timestamp, nonce, privateKeyPem) {
  return crypto.sign(
    null,
    Buffer.from(`nearby-transfer:library-auth:${deviceId}:${timestamp}:${nonce}`, 'utf8'),
    crypto.createPrivateKey(privateKeyPem)
  ).toString('base64');
}

function handshakePayload(deviceId, timestamp, nonce, privateKeyPem) {
  return JSON.stringify({
    deviceId,
    timestamp,
    nonce,
    signature: handshakeSignature(deviceId, timestamp, nonce, privateKeyPem)
  });
}

function handshakeRequest(port, body) {
  return httpRequest({
    hostname: '127.0.0.1',
    port,
    path: '/api/session',
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  }, body);
}

async function assertHandshake(port) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const store = new MockTrustedPeerStore({
    'peer-signing': {
      deviceId: 'peer-signing',
      isTrusted: () => true,
      signingPublicKey: publicKeyPem,
      permissions: { libraryRead: true, libraryUpload: false, transfer: true }
    }
  });
  const signingService = new DesktopLibraryService({
    trustedPeerStore: store,
    shares: [{ id: 'docs', name: 'Documents', localPath: fs.mkdtempSync(path.join(os.tmpdir(), 'nearby-handshake-')), readOnly: true }]
  });
  const signingPort = await signingService.start(0);

  try {
    // Missing fields are rejected before any trust lookup happens
    const missing = await handshakeRequest(signingPort, JSON.stringify({ deviceId: 'peer-signing', timestamp: Date.now(), nonce: 'a'.repeat(32) }));
    assert.strictEqual(missing.statusCode, 401);

    // A signature computed over a different nonce does not validate
    const bodyNonce = 'b'.repeat(32);
    const signedNonce = 'c'.repeat(32);
    const mismatched = await handshakeRequest(signingPort, JSON.stringify({
      deviceId: 'peer-signing',
      timestamp: Date.now(),
      nonce: bodyNonce,
      signature: handshakeSignature('peer-signing', Date.now(), signedNonce, privateKeyPem)
    }));
    assert.strictEqual(mismatched.statusCode, 401);

    // Stale timestamps are outside the accepted window
    const stale = await handshakeRequest(signingPort, handshakePayload('peer-signing', Date.now() - 61 * 1000, 'd'.repeat(32), privateKeyPem));
    assert.strictEqual(stale.statusCode, 401);

    // A valid signed handshake yields a working bearer token
    const nonce = 'e'.repeat(32);
    const valid = await handshakeRequest(signingPort, handshakePayload('peer-signing', Date.now(), nonce, privateKeyPem));
    assert.strictEqual(valid.statusCode, 200);
    const token = JSON.parse(valid.body).token;
    assert.ok(token, 'handshake must return a token');
    const listed = await httpRequest({
      hostname: '127.0.0.1',
      port: signingPort,
      path: '/docs/',
      method: 'PROPFIND',
      headers: { Authorization: `Bearer ${token}` }
    });
    assert.strictEqual(listed.statusCode, 207);

    // Replaying the same nonce fails even with a valid signature
    const replay = await handshakeRequest(signingPort, handshakePayload('peer-signing', Date.now(), nonce, privateKeyPem));
    assert.strictEqual(replay.statusCode, 401);

    // A garbage signature is rejected
    const forged = await handshakeRequest(signingPort, JSON.stringify({
      deviceId: 'peer-signing',
      timestamp: Date.now(),
      nonce: 'f'.repeat(32),
      signature: Buffer.from('not-a-signature').toString('base64')
    }));
    assert.strictEqual(forged.statusCode, 401);
  } finally {
    await signingService.stop();
  }
}

async function assertHandshakeRateLimit() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const store = new MockTrustedPeerStore({
    'peer-rate': {
      deviceId: 'peer-rate',
      isTrusted: () => true,
      signingPublicKey: publicKey.export({ type: 'spki', format: 'pem' }),
      permissions: { libraryRead: true, libraryUpload: false, transfer: true }
    }
  });
  const service = new DesktopLibraryService({
    trustedPeerStore: store,
    shares: [{ id: 'docs', name: 'Documents', localPath: fs.mkdtempSync(path.join(os.tmpdir(), 'nearby-rate-')), readOnly: true }]
  });
  const port = await service.start(0);
  try {
    let sawThrottled = false;
    for (let attempt = 1; attempt <= 12; attempt += 1) {
      const nonce = String(attempt).padStart(32, '0');
      const res = await handshakeRequest(port, handshakePayload('peer-rate', Date.now(), nonce, privateKeyPem));
      if (res.statusCode === 429) {
        assert.ok(attempt > 10, `rate limit must allow the first 10 requests (throttled at ${attempt})`);
        assert.ok(res.headers['retry-after'], '429 must carry Retry-After');
        sawThrottled = true;
      }
    }
    assert.ok(sawThrottled, 'rate limiter must eventually return 429');
  } finally {
    await service.stop();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

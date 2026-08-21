'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
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

    console.log('desktop library service smoke tests passed');
  } finally {
    await service.stop();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

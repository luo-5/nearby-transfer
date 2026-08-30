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

  const originalWatch = fs.watch;
  const watchCalls = [];
  let service;
  try {
    fs.watch = (watchPath, options, listener) => {
      const watcher = {
        on() { return watcher; },
        close() {}
      };
      watchCalls.push({ watchPath, options, listener });
      return watcher;
    };
    service = new DesktopLibraryService({
      trustedPeerStore: peerStore,
      shares: [
        { id: 'docs', name: 'Documents', localPath: shareADir, readOnly: false },
        { id: 'readonly', name: 'ReadOnlyShare', localPath: shareBDir, readOnly: true }
      ]
    });
  } finally {
    fs.watch = originalWatch;
  }
  assert.deepStrictEqual(watchCalls.map(({ watchPath }) => watchPath), [
    fs.realpathSync.native(shareADir),
    fs.realpathSync.native(shareBDir)
  ]);
  for (const { options, listener } of watchCalls) {
    assert.deepStrictEqual(options, { recursive: true });
    assert.strictEqual(typeof listener, 'function');
  }

  let port = await service.start(0);
  assert.ok(port > 0, 'Service must bind to a dynamic port');
  assert.strictEqual(service.getStatus().running, true);
  assert.strictEqual(service.getStatus().shareCount, 2);

  try {
    const fullToken = service.createSessionToken('peer-full-access');
    const readToken = service.createSessionToken('peer-read-only');

    const sharesResponse = await httpRequest({
      hostname: '127.0.0.1', port, path: '/api/shares', method: 'GET',
      headers: { Authorization: `Bearer ${fullToken}` }
    });
    assert.strictEqual(sharesResponse.statusCode, 200);
    const remoteShares = JSON.parse(sharesResponse.body).shares;
    assert.strictEqual(remoteShares.length, 2);
    assert.strictEqual(Object.hasOwn(remoteShares[0], 'localPath'), false);

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

    // 9. Mutating methods must never remove, move, copy, or replace a share root.
    const rootDelete = await httpRequest({
      hostname: '127.0.0.1', port, path: '/docs', method: 'DELETE',
      headers: { Authorization: `Bearer ${fullToken}` }
    });
    assert.strictEqual(rootDelete.statusCode, 403);

    const rootCopy = await httpRequest({
      hostname: '127.0.0.1', port, path: '/docs', method: 'COPY',
      headers: { Authorization: `Bearer ${fullToken}`, Destination: '/webdav/docs/root-copy' }
    });
    assert.strictEqual(rootCopy.statusCode, 403);

    const rootMove = await httpRequest({
      hostname: '127.0.0.1', port, path: '/docs', method: 'MOVE',
      headers: { Authorization: `Bearer ${fullToken}`, Destination: '/webdav/docs/root-move' }
    });
    assert.strictEqual(rootMove.statusCode, 403);

    const copyOntoRoot = await httpRequest({
      hostname: '127.0.0.1', port, path: '/docs/newfile.txt', method: 'COPY',
      headers: { Authorization: `Bearer ${fullToken}`, Destination: '/webdav/docs', Overwrite: 'T' }
    });
    assert.strictEqual(copyOntoRoot.statusCode, 403);

    const moveOntoRoot = await httpRequest({
      hostname: '127.0.0.1', port, path: '/docs/newfile.txt', method: 'MOVE',
      headers: { Authorization: `Bearer ${fullToken}`, Destination: '/webdav/docs', Overwrite: 'T' }
    });
    assert.strictEqual(moveOntoRoot.statusCode, 403);
    assert.strictEqual(fs.existsSync(shareADir), true);
    assert.strictEqual(fs.readFileSync(path.join(shareADir, 'hello.txt'), 'utf8'), 'Hello WebDAV World');
    assert.strictEqual(fs.readFileSync(path.join(shareADir, 'newfile.txt'), 'utf8'), 'Brand new uploaded file');

    // Existing tokens must observe permission updates immediately.
    const fullPeer = peerStore.peers.get('peer-full-access');
    fullPeer.permissions.libraryUpload = false;
    const putAfterPermissionRemoval = await httpRequest({
      hostname: '127.0.0.1', port, path: '/docs/permission-denied.txt', method: 'PUT',
      headers: { Authorization: `Bearer ${fullToken}` }
    }, 'must not be written');
    assert.strictEqual(putAfterPermissionRemoval.statusCode, 403);
    assert.strictEqual(fs.existsSync(path.join(shareADir, 'permission-denied.txt')), false);
    fullPeer.permissions.libraryUpload = true;

    // Write destinations use one portable-name policy across all mutating methods.
    const trailingSpacePut = await httpRequest({
      hostname: '127.0.0.1', port, path: '/docs/trailing%20', method: 'PUT',
      headers: { Authorization: `Bearer ${fullToken}` }
    }, 'invalid');
    assert.strictEqual(trailingSpacePut.statusCode, 400);
    const superscriptReservedMkcol = await httpRequest({
      hostname: '127.0.0.1', port, path: '/docs/COM%C2%B9', method: 'MKCOL',
      headers: { Authorization: `Bearer ${fullToken}` }
    });
    assert.strictEqual(superscriptReservedMkcol.statusCode, 400);
    const invalidCopyDestination = await httpRequest({
      hostname: '127.0.0.1', port, path: '/docs/newfile.txt', method: 'COPY',
      headers: { Authorization: `Bearer ${fullToken}`, Destination: '/webdav/docs/copy-target.' }
    });
    assert.strictEqual(invalidCopyDestination.statusCode, 400);
    const invalidMoveDestination = await httpRequest({
      hostname: '127.0.0.1', port, path: '/docs/newfile.txt', method: 'MOVE',
      headers: { Authorization: `Bearer ${fullToken}`, Destination: '/webdav/docs/LPT%C2%B2.log' }
    });
    assert.strictEqual(invalidMoveDestination.statusCode, 400);
    const malformedCopyDestination = await httpRequest({
      hostname: '127.0.0.1', port, path: '/docs/newfile.txt', method: 'COPY',
      headers: { Authorization: `Bearer ${fullToken}`, Destination: '/webdav/docs/%zz' }
    });
    assert.strictEqual(malformedCopyDestination.statusCode, 400);
    assert.strictEqual(fs.readFileSync(path.join(shareADir, 'newfile.txt'), 'utf8'), 'Brand new uploaded file');

    // COPY/MOVE must obey the same new-file-only policy even with Overwrite: T.
    fs.writeFileSync(path.join(shareADir, 'copy-source.txt'), 'source');
    fs.writeFileSync(path.join(shareADir, 'copy-victim.txt'), 'victim');
    const copyOverwrite = await httpRequest({
      hostname: '127.0.0.1', port, path: '/docs/copy-source.txt', method: 'COPY',
      headers: { Authorization: `Bearer ${fullToken}`, Destination: '/webdav/docs/copy-victim.txt', Overwrite: 'T' }
    });
    assert.strictEqual(copyOverwrite.statusCode, 412);
    assert.strictEqual(fs.readFileSync(path.join(shareADir, 'copy-victim.txt'), 'utf8'), 'victim');

    fs.writeFileSync(path.join(shareADir, 'move-source.txt'), 'move-source');
    fs.writeFileSync(path.join(shareADir, 'move-victim.txt'), 'move-victim');
    const moveOverwrite = await httpRequest({
      hostname: '127.0.0.1', port, path: '/docs/move-source.txt', method: 'MOVE',
      headers: { Authorization: `Bearer ${fullToken}`, Destination: '/webdav/docs/move-victim.txt', Overwrite: 'T' }
    });
    assert.strictEqual(moveOverwrite.statusCode, 412);
    assert.strictEqual(fs.readFileSync(path.join(shareADir, 'move-source.txt'), 'utf8'), 'move-source');
    assert.strictEqual(fs.readFileSync(path.join(shareADir, 'move-victim.txt'), 'utf8'), 'move-victim');

    // Directory COPY/MOVE fail closed until a crash-recoverable publication protocol exists.
    const directorySource = path.join(shareADir, 'directory-source');
    fs.mkdirSync(path.join(directorySource, 'nested', 'empty'), { recursive: true });
    fs.writeFileSync(path.join(directorySource, 'nested', 'payload.txt'), 'directory-payload');
    const copyDirectory = await httpRequest({
      hostname: '127.0.0.1', port, path: '/docs/directory-source', method: 'COPY',
      headers: { Authorization: `Bearer ${fullToken}`, Destination: '/webdav/docs/directory-copy' }
    });
    assert.strictEqual(copyDirectory.statusCode, 409);
    assert.strictEqual(fs.existsSync(path.join(shareADir, 'directory-copy')), false);
    const moveDirectory = await httpRequest({
      hostname: '127.0.0.1', port, path: '/docs/directory-source', method: 'MOVE',
      headers: { Authorization: `Bearer ${fullToken}`, Destination: '/webdav/docs/directory-moved' }
    });
    assert.strictEqual(moveDirectory.statusCode, 409);
    assert.strictEqual(fs.existsSync(directorySource), true);
    assert.strictEqual(fs.existsSync(path.join(shareADir, 'directory-moved')), false);

    // Filesystems without hard-link support fail closed instead of exposing a partial final.
    const originalLinkSync = fs.linkSync;
    try {
      fs.linkSync = () => {
        const error = new Error('hard links unavailable in fixture');
        error.code = 'ENOTSUP';
        throw error;
      };
      const fallbackPut = await httpRequest({
        hostname: '127.0.0.1', port, path: '/docs/fallback-put.txt', method: 'PUT',
        headers: { Authorization: `Bearer ${fullToken}` }
      }, 'fallback-put');
      assert.strictEqual(fallbackPut.statusCode, 500);
      assert.strictEqual(fs.existsSync(path.join(shareADir, 'fallback-put.txt')), false);
      fs.writeFileSync(path.join(shareADir, 'fallback-copy-source.txt'), 'fallback-copy');
      const fallbackCopy = await httpRequest({
        hostname: '127.0.0.1', port, path: '/docs/fallback-copy-source.txt', method: 'COPY',
        headers: { Authorization: `Bearer ${fullToken}`, Destination: '/webdav/docs/fallback-copy.txt' }
      });
      assert.strictEqual(fallbackCopy.statusCode, 500);
      assert.strictEqual(fs.existsSync(path.join(shareADir, 'fallback-copy.txt')), false);
      fs.writeFileSync(path.join(shareADir, 'fallback-move-source.txt'), 'fallback-move');
      const fallbackMove = await httpRequest({
        hostname: '127.0.0.1', port, path: '/docs/fallback-move-source.txt', method: 'MOVE',
        headers: { Authorization: `Bearer ${fullToken}`, Destination: '/webdav/docs/fallback-move.txt' }
      });
      assert.strictEqual(fallbackMove.statusCode, 500);
      assert.strictEqual(fs.readFileSync(path.join(shareADir, 'fallback-move-source.txt'), 'utf8'), 'fallback-move');
      assert.strictEqual(fs.existsSync(path.join(shareADir, 'fallback-move.txt')), false);
    } finally {
      fs.linkSync = originalLinkSync;
    }

    // Failed COPY writes only to owned staging and never exposes a partial final file.
    fs.writeFileSync(path.join(shareADir, 'copy-failure-source.txt'), 'complete-source');
    const originalCopyFileSync = fs.copyFileSync;
    try {
      fs.copyFileSync = (_source, staging) => {
        fs.writeFileSync(staging, 'PARTIAL', { flag: 'wx' });
        const error = new Error('injected copy failure');
        error.code = 'EIO';
        throw error;
      };
      const failedCopy = await httpRequest({
        hostname: '127.0.0.1', port, path: '/docs/copy-failure-source.txt', method: 'COPY',
        headers: { Authorization: `Bearer ${fullToken}`, Destination: '/webdav/docs/copy-failure-final.txt' }
      });
      assert.strictEqual(failedCopy.statusCode, 500);
    } finally {
      fs.copyFileSync = originalCopyFileSync;
    }
    assert.strictEqual(fs.existsSync(path.join(shareADir, 'copy-failure-final.txt')), false);
    assert.deepStrictEqual(fs.readdirSync(shareADir).filter((name) => name.startsWith('.nearby-copy-')), []);

    // Failed source removal retains both complete names instead of risking data loss.
    const moveRollbackSource = path.join(shareADir, 'move-rollback-source.txt');
    const moveRollbackDest = path.join(shareADir, 'move-rollback-final.txt');
    fs.writeFileSync(moveRollbackSource, 'rollback-source');
    const originalRenameSync = fs.renameSync;
    try {
      fs.renameSync = (source, destination) => {
        if (path.resolve(String(source)) === path.resolve(moveRollbackSource)) {
          const error = new Error('injected source removal failure');
          error.code = 'EPERM';
          throw error;
        }
        return originalRenameSync(source, destination);
      };
      const failedMove = await httpRequest({
        hostname: '127.0.0.1', port, path: '/docs/move-rollback-source.txt', method: 'MOVE',
        headers: { Authorization: `Bearer ${fullToken}`, Destination: '/webdav/docs/move-rollback-final.txt' }
      });
      assert.strictEqual(failedMove.statusCode, 500);
      assert.strictEqual(JSON.parse(failedMove.body).state, 'destination-published-source-retained');
    } finally {
      fs.renameSync = originalRenameSync;
    }
    assert.strictEqual(fs.existsSync(moveRollbackSource), true);
    assert.strictEqual(fs.readFileSync(moveRollbackDest, 'utf8'), 'rollback-source');
    assert.deepStrictEqual(fs.readdirSync(shareADir).filter((name) => name.startsWith('.nearby-move-cleanup-')), []);

    await interruptUpload(port, fullToken, '/docs/interrupted.bin', Buffer.from('partial'));
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.strictEqual(fs.existsSync(path.join(shareADir, 'interrupted.bin')), false);
    assert.deepStrictEqual(fs.readdirSync(shareADir).filter((name) => name.startsWith('.nearby-upload-')), []);

    // 10. Path traversal attempt must be blocked with 403
    const traversal = await httpRequest({
      hostname: '127.0.0.1',
      port,
      path: '/docs/../outside.txt',
      method: 'GET',
      headers: { Authorization: `Bearer ${readToken}` }
    });
    assert.strictEqual(traversal.statusCode, 403);

    // 11. Malformed percent-encoding must be rejected with 400 instead of hanging
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

    // Stopping is a resource barrier even while an SSE stream is open.
    const sse = await openSse(port, fullToken);
    const stopped = await Promise.race([
      service.stop().then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 1000))
    ]);
    assert.strictEqual(stopped, true, 'stop must not wait indefinitely for SSE clients');
    sse.destroy();
    port = await service.start(0);
    assert.ok(port > 0, 'service must restart after a bounded stop');

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

function interruptUpload(port, token, requestPath, chunk) {
  return new Promise((resolve) => {
    const req = https.request({
      hostname: '127.0.0.1',
      port,
      path: requestPath,
      method: 'PUT',
      rejectUnauthorized: false,
      headers: { Authorization: `Bearer ${token}`, 'Content-Length': String(chunk.length + 1024) }
    });
    req.on('error', () => resolve());
    req.write(chunk, () => req.destroy());
  });
}

function openSse(port, token) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: '127.0.0.1',
      port,
      path: '/api/events',
      method: 'GET',
      rejectUnauthorized: false,
      headers: { Authorization: `Bearer ${token}` }
    });
    req.once('response', (res) => resolve(res));
    req.once('error', reject);
    req.end();
  });
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

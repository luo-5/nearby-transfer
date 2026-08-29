'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const crypto = require('crypto');
const { DesktopLibraryService } = require('../src/v2/desktop-library-service');
const certManager = require('../src/v2/cert-manager');

class MockTrustedPeerStore {
  constructor(peers = {}) {
    this.peers = new Map(Object.entries(peers));
  }

  getPeer(deviceId) {
    return this.peers.get(deviceId) || null;
  }
}

function httpsRequest(options, body = null) {
  return new Promise((resolve, reject) => {
    options.rejectUnauthorized = false; // Self-signed test certificate
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

function signedHandshakeBody(deviceId, privateKeyPem) {
  const timestamp = Date.now();
  const nonce = crypto.randomBytes(16).toString('hex');
  const signature = crypto.sign(
    null,
    Buffer.from(`nearby-transfer:library-auth:${deviceId}:${timestamp}:${nonce}`, 'utf8'),
    crypto.createPrivateKey(privateKeyPem)
  ).toString('base64');
  return JSON.stringify({ deviceId, timestamp, nonce, signature });
}

async function runHttpsWebDavStressTests() {
  console.log('======================================================');
  console.log('   MULTI-ROUND HTTPS WEBDAV CONCURRENCY & STRESS TEST ');
  console.log('======================================================\n');

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nearby-webdav-stress-'));
  const testShareDir = path.join(tempDir, 'stressShare');
  const readOnlyShareDir = path.join(tempDir, 'readOnlyShare');
  fs.mkdirSync(testShareDir, { recursive: true });
  fs.mkdirSync(readOnlyShareDir, { recursive: true });

  const clientFullKeys = crypto.generateKeyPairSync('ed25519');
  const clientReadonlyKeys = crypto.generateKeyPairSync('ed25519');
  const clientFullPrivateKeyPem = clientFullKeys.privateKey.export({ type: 'pkcs8', format: 'pem' });
  const clientReadonlyPrivateKeyPem = clientReadonlyKeys.privateKey.export({ type: 'pkcs8', format: 'pem' });

  const peerStore = new MockTrustedPeerStore({
    'trusted-client-full': {
      deviceId: 'trusted-client-full',
      isTrusted: () => true,
      signingPublicKey: clientFullKeys.publicKey.export({ type: 'spki', format: 'pem' }),
      permissions: { libraryRead: true, libraryUpload: true, transfer: true }
    },
    'trusted-client-readonly': {
      deviceId: 'trusted-client-readonly',
      isTrusted: () => true,
      signingPublicKey: clientReadonlyKeys.publicKey.export({ type: 'spki', format: 'pem' }),
      permissions: { libraryRead: true, libraryUpload: false, transfer: true }
    }
  });

  const service = new DesktopLibraryService({
    trustedPeerStore: peerStore,
    shares: [
      { id: 'stress-share', name: 'Stress Share', localPath: testShareDir, readOnly: false },
      { id: 'ro-share', name: 'Read Only Share', localPath: readOnlyShareDir, readOnly: true }
    ]
  });

  try {
    const port = await service.start();
    assert(typeof port === 'number' && port > 0, `Expected port number, got ${port}`);
    console.log(`[+] DesktopLibraryService HTTPS started on port ${port}`);

    // --- ROUND 1: Certificate Verification & Auth Handshake ---
    console.log('\n--- ROUND 1: Certificate & Handshake ---');
    const { cert, key } = certManager.getOrCreateCert();
    assert(cert.includes('BEGIN CERTIFICATE'), 'Must be a valid PEM certificate');
    assert(key.includes('BEGIN RSA PRIVATE KEY') || key.includes('BEGIN PRIVATE KEY'), 'Must be a valid PEM private key');

    // Authenticate full access client
    const authRes = await httpsRequest({
      hostname: '127.0.0.1',
      port,
      path: '/api/session',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, signedHandshakeBody('trusted-client-full', clientFullPrivateKeyPem));

    assert.strictEqual(authRes.statusCode, 200);
    const authData = JSON.parse(authRes.body);
    assert(authData.token, 'Must return session token');
    const token = authData.token;
    console.log('[PASS] Round 1: HTTPS Handshake and session token acquired.');

    // --- ROUND 2: Full CRUD Lifecycle (MKCOL, PUT, PROPFIND, GET, DELETE) ---
    console.log('\n--- ROUND 2: Full CRUD Lifecycle ---');
    // MKCOL nested directory
    const mkcolRes = await httpsRequest({
      hostname: '127.0.0.1',
      port,
      path: '/webdav/stress-share/subfolder_alpha',
      method: 'MKCOL',
      headers: { Authorization: `Bearer ${token}` }
    });
    assert([200, 201, 204].includes(mkcolRes.statusCode), `MKCOL failed with code ${mkcolRes.statusCode}`);
    assert(fs.existsSync(path.join(testShareDir, 'subfolder_alpha')), 'Directory must exist on disk');

    // PUT file into subfolder
    const payload = crypto.randomBytes(64 * 1024); // 64KB random data
    const expectedMd5 = crypto.createHash('md5').update(payload).digest('hex');

    const putRes = await httpsRequest({
      hostname: '127.0.0.1',
      port,
      path: '/webdav/stress-share/subfolder_alpha/binary_data.bin',
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/octet-stream',
        'Content-Length': payload.length
      }
    }, payload);
    assert([200, 201, 204].includes(putRes.statusCode), `PUT failed with code ${putRes.statusCode}`);

    // GET file and verify MD5
    const getRes = await httpsRequest({
      hostname: '127.0.0.1',
      port,
      path: '/webdav/stress-share/subfolder_alpha/binary_data.bin',
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` }
    });
    assert.strictEqual(getRes.statusCode, 200);
    const actualMd5 = crypto.createHash('md5').update(getRes.rawBody).digest('hex');
    assert.strictEqual(actualMd5, expectedMd5, 'Downloaded content MD5 must match uploaded content');

    // List via /api/list
    const listRes = await httpsRequest({
      hostname: '127.0.0.1',
      port,
      path: '/api/list?shareId=stress-share&path=subfolder_alpha',
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` }
    });
    assert.strictEqual(listRes.statusCode, 200);
    const listData = JSON.parse(listRes.body);
    assert(listData.items.some(i => i.name === 'binary_data.bin'), 'File must be listed');

    // DELETE file
    const delFileRes = await httpsRequest({
      hostname: '127.0.0.1',
      port,
      path: '/webdav/stress-share/subfolder_alpha/binary_data.bin',
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` }
    });
    assert([200, 204].includes(delFileRes.statusCode));
    assert(!fs.existsSync(path.join(testShareDir, 'subfolder_alpha', 'binary_data.bin')), 'File must be deleted from disk');

    // DELETE directory
    const delDirRes = await httpsRequest({
      hostname: '127.0.0.1',
      port,
      path: '/webdav/stress-share/subfolder_alpha',
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` }
    });
    assert([200, 204].includes(delDirRes.statusCode));
    assert(!fs.existsSync(path.join(testShareDir, 'subfolder_alpha')), 'Directory must be deleted from disk');
    console.log('[PASS] Round 2: Full CRUD lifecycle (MKCOL -> PUT -> GET MD5 -> List -> DELETE file -> DELETE dir) verified!');

    // --- ROUND 3: Concurrency Stress (10 Parallel Uploads & Reads) ---
    console.log('\n--- ROUND 3: Concurrency Stress (10 Parallel Uploads) ---');
    const parallelTasks = [];
    for (let i = 1; i <= 10; i++) {
      parallelTasks.push((async (idx) => {
        const fileContent = `Parallel File #${idx} - ` + crypto.randomBytes(512).toString('hex');
        const filename = `parallel_${idx}.txt`;
        const res = await httpsRequest({
          hostname: '127.0.0.1',
          port,
          path: `/webdav/stress-share/${filename}`,
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'text/plain',
            'Content-Length': Buffer.byteLength(fileContent)
          }
        }, fileContent);
        assert([200, 201, 204].includes(res.statusCode), `Concurrent PUT #${idx} failed`);
      })(i));
    }

    await Promise.all(parallelTasks);

    const checkList = await httpsRequest({
      hostname: '127.0.0.1',
      port,
      path: '/api/list?shareId=stress-share',
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` }
    });
    const checkListData = JSON.parse(checkList.body);
    assert.strictEqual(checkListData.items.length, 10, 'All 10 parallel files must be present');
    console.log('[PASS] Round 3: Handled 10 parallel HTTPS WebDAV uploads with zero race conditions.');

    // --- ROUND 4: Security & Penetration Testing ---
    console.log('\n--- ROUND 4: Security & Penetration Testing ---');
    // Unauthorized token
    const unauthRes = await httpsRequest({
      hostname: '127.0.0.1',
      port,
      path: '/api/list?shareId=stress-share',
      method: 'GET',
      headers: { Authorization: 'Bearer invalid-token-12345' }
    });
    assert.strictEqual(unauthRes.statusCode, 401, 'Invalid token must return 401');

    // Path traversal attack vector
    const traversalRes = await httpsRequest({
      hostname: '127.0.0.1',
      port,
      path: '/webdav/stress-share/..%2f..%2f..%2fpackage.json',
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` }
    });
    assert([400, 403, 404].includes(traversalRes.statusCode), 'Path traversal must be blocked');

    // Read-only permission check
    const roAuthRes = await httpsRequest({
      hostname: '127.0.0.1',
      port,
      path: '/api/session',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, signedHandshakeBody('trusted-client-readonly', clientReadonlyPrivateKeyPem));
    const roToken = JSON.parse(roAuthRes.body).token;

    const roPutRes = await httpsRequest({
      hostname: '127.0.0.1',
      port,
      path: '/webdav/ro-share/unauthorized_file.txt',
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${roToken}`,
        'Content-Type': 'text/plain',
        'Content-Length': 5
      }
    }, 'hello');
    assert.strictEqual(roPutRes.statusCode, 403, 'Read-only share or peer must reject PUT with 403');
    console.log('[PASS] Round 4: Security defenses (401 auth, path traversal guard, 403 read-only) verified!');

    // --- ROUND 5: SSE Event Stream Notification Test ---
    console.log('\n--- ROUND 5: Real-time SSE Sync Notifications ---');
    const receivedEvents = [];
    let sseReq = null;

    const ssePromise = new Promise((resolve, reject) => {
      const options = {
        hostname: '127.0.0.1',
        port,
        path: '/api/events',
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
        rejectUnauthorized: false
      };
      sseReq = https.request(options, (res) => {
        assert.strictEqual(res.statusCode, 200);
        res.on('data', (chunk) => {
          const text = chunk.toString('utf8');
          const lines = text.split('\n');
          for (const line of lines) {
            if (line.startsWith('data: ')) {
              try {
                const ev = JSON.parse(line.slice(6));
                receivedEvents.push(ev);
                if (receivedEvents.length >= 2) {
                  resolve();
                }
              } catch (_) {}
            }
          }
        });
      });
      sseReq.on('error', reject);
      sseReq.end();
    });

    // Allow SSE to connect
    await new Promise(r => setTimeout(r, 200));

    // Trigger changes
    await httpsRequest({
      hostname: '127.0.0.1',
      port,
      path: '/webdav/stress-share/sse_test.txt',
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'text/plain',
        'Content-Length': 7
      }
    }, 'sse-msg');

    await httpsRequest({
      hostname: '127.0.0.1',
      port,
      path: '/webdav/stress-share/sse_test.txt',
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` }
    });

    await Promise.race([
      ssePromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('SSE notification timeout')), 5000))
    ]);

    if (sseReq) {
      sseReq.destroy();
    }

    assert(receivedEvents.length >= 2, 'Must receive at least 2 events via SSE');
    console.log(`[PASS] Round 5: Received ${receivedEvents.length} real-time SSE sync events.`);

    console.log('\n======================================================');
    console.log(' ALL 5 ROUNDS OF HTTPS WEBDAV STRESS TESTS PASSED!    ');
    console.log('======================================================');
  } finally {
    await service.stop();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

runHttpsWebDavStressTests().catch((err) => {
  console.error('[FAIL] HTTPS WebDAV stress tests failed:', err);
  process.exit(1);
});

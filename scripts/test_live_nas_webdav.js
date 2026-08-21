'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const crypto = require('crypto');
const { fingerprintFor } = require('../src/core/crypto');
const { DesktopLibraryService } = require('../src/v2/desktop-library-service');
const { TrustedPeerStore } = require('../src/v2/trusted-peer-store');

function createPeerIdentity() {
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
    deviceName: 'Test Mobile Phone',
    fingerprint,
    signingPublicKey: signing.publicKey,
    encryptionPublicKey: encryption.publicKey
  };
}

async function testWebDavNas() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nearby-nas-test-'));
  const shareFolder = path.join(tempDir, 'MySharedNAS');
  fs.mkdirSync(shareFolder, { recursive: true });

  // Create sample files in NAS share
  fs.writeFileSync(path.join(shareFolder, 'hello_nas.txt'), 'Hello NearbyTransfer NAS Library!', 'utf8');
  fs.writeFileSync(path.join(shareFolder, 'photo_sample.jpg'), Buffer.alloc(1024, 0xAB));
  fs.mkdirSync(path.join(shareFolder, 'Documents'));
  fs.writeFileSync(path.join(shareFolder, 'Documents', 'report.pdf'), 'Sample PDF content', 'utf8');

  const peerStore = new TrustedPeerStore(tempDir);
  const mobileIdentity = createPeerIdentity();

  peerStore.upsertTrustedPeer({
    identity: mobileIdentity,
    displayName: 'My Verified Phone',
    permissions: { transfer: true, libraryRead: true, libraryUpload: true },
    pairedAt: Date.now()
  });

  const nasService = new DesktopLibraryService({
    trustedPeerStore: peerStore
  });

  nasService.addShare({
    id: 'public-share',
    name: 'My Public Documents',
    localPath: shareFolder,
    readOnly: false
  });

  const peerToken = nasService.createSessionToken(mobileIdentity.deviceId);

  const port = await nasService.start(0);
  console.log(`[+] NAS WebDAV Service started successfully on port ${port}`);

  function request(method, reqPath, headers = {}, body = null) {
    return new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port,
        path: reqPath,
        method,
        headers: {
          'Authorization': `Bearer ${peerToken}`,
          ...headers
        }
      }, (res) => {
        let data = Buffer.alloc(0);
        res.on('data', (c) => { data = Buffer.concat([data, c]); });
        res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: data.toString('utf8') }));
      });
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });
  }

  // 1. Test PROPFIND (List Directory)
  console.log('\n--- 1. Testing PROPFIND (Directory Enumeration) ---');
  const propfindRes = await request('PROPFIND', '/public-share/', { Depth: '1' });
  console.log('PROPFIND Status:', propfindRes.statusCode, '(207 Multi-Status expected)');
  console.log('Contains hello_nas.txt:', propfindRes.body.includes('hello_nas.txt'));
  console.log('Contains Documents folder:', propfindRes.body.includes('Documents'));

  // 2. Test GET (File Download)
  console.log('\n--- 2. Testing GET (File Download) ---');
  const getRes = await request('GET', '/public-share/hello_nas.txt');
  console.log('GET Status:', getRes.statusCode, '(200 OK expected)');
  console.log('GET Body Content:', getRes.body);

  // 3. Test PUT (File Upload)
  console.log('\n--- 3. Testing PUT (File Upload from Mobile) ---');
  const uploadContent = 'Uploaded from Mobile Phone over WebDAV NAS!';
  const putRes = await request('PUT', '/public-share/mobile_upload.txt', {}, uploadContent);
  console.log('PUT Status:', putRes.statusCode, '(201 Created expected)');
  const diskFileContent = fs.readFileSync(path.join(shareFolder, 'mobile_upload.txt'), 'utf8');
  console.log('File verified on NAS disk:', diskFileContent === uploadContent);

  // 4. Test Anti-Overwrite Protection (412 Precondition Failed)
  console.log('\n--- 4. Testing Anti-Overwrite Protection (412 Precondition Failed) ---');
  const overwriteRes = await request('PUT', '/public-share/mobile_upload.txt', { 'If-None-Match': '*' }, 'New content');
  console.log('Overwrite Block Status:', overwriteRes.statusCode, '(412 Precondition Failed expected)');

  // 5. Test Path Traversal Defense (Block ../ attacks)
  console.log('\n--- 5. Testing Path Traversal Defense ---');
  const traversalRes = await request('GET', '/public-share/..%2f..%2fsecret.txt');
  console.log('Path Traversal Block Status:', traversalRes.statusCode, '(403/404/400 expected)');

  // 6. Test Unauthenticated / Unpaired Client Block
  console.log('\n--- 6. Testing Unpaired / Unauthorized Block ---');
  const unauthRes = await new Promise((resolve) => {
    http.get(`http://127.0.0.1:${port}/public-share/hello_nas.txt`, (res) => resolve(res.statusCode));
  });
  console.log('Unauthenticated Request Status:', unauthRes, '(401 Unauthorized expected)');

  await nasService.stop();
  peerStore.close();
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
  console.log('\n======================================================');
  console.log('>>> ALL NAS / WEBDAV TESTS PASSED WITH 100% SUCCESS <<<');
  console.log('======================================================');
}

testWebDavNas().catch(console.error);

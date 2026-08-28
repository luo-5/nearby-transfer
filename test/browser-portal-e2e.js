'use strict';

// test/browser-portal-e2e.js
// End-to-End simulation of Web Browser Portal interactions:
// 1. Web portal session handshake and authorization
// 2. Directory browsing JSON API (/api/shares, /api/list, /api/browse)
// 3. HTTP Range partial content downloads for video/media streaming
// 4. Chunked file uploads with Unicode & GB18030 filenames
// 5. Server-Sent Events (SSE) real-time file sync stream (/api/events)

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const { DesktopLibraryService } = require('../src/v2/desktop-library-service');

let passed = 0;
let failed = 0;

function ok(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  [PASS] ${name}`); }
  else { failed++; console.log(`  [FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
}

class MockTrustedPeerStore {
  constructor(peers = {}) { this.peers = new Map(Object.entries(peers)); }
  getPeer(deviceId) { return this.peers.get(deviceId) || null; }
}

function httpRequest(options, body = null) {
  return new Promise((resolve, reject) => {
    const opts = { ...options, rejectUnauthorized: false };
    const req = https.request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        resolve({ statusCode: res.statusCode, headers: res.headers, body: buf.toString('utf8'), rawBody: buf });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function main() {
  console.log('======================================================');
  console.log('     BROWSER WEB PORTAL END-TO-END VERIFICATION      ');
  console.log('======================================================');

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-web-portal-'));
  const shareDir = path.join(tempDir, 'portal_share');
  fs.mkdirSync(shareDir);

  // Seed with diverse media and unicode files
  fs.writeFileSync(path.join(shareDir, 'sample_video.mp4'), Buffer.alloc(1024 * 50, 0xAA));
  fs.writeFileSync(path.join(shareDir, '中文文档_财务报表 📊.pdf'), Buffer.from('PDF Mock Content with GB18030/Unicode characters'));
  fs.mkdirSync(path.join(shareDir, 'photos_2026'));
  fs.writeFileSync(path.join(shareDir, 'photos_2026', 'vacation_🌅.jpg'), Buffer.alloc(1024 * 10, 0xBB));

  const peerStore = new MockTrustedPeerStore({
    'browser-peer': {
      deviceId: 'browser-peer',
      isTrusted: () => true,
      permissions: { libraryRead: true, libraryUpload: true, transfer: true }
    }
  });

  const service = new DesktopLibraryService({
    trustedPeerStore: peerStore,
    shares: [{ id: 'main-library', name: 'Main Library', localPath: shareDir, readOnly: false }]
  });

  const port = await service.start(0);
  const base = { host: '127.0.0.1', port };
  const token = service.createSessionToken('browser-peer');
  const authHeaders = { Authorization: `Bearer ${token}`, Host: '127.0.0.1' };

  try {
    // --- 1. Test /api/shares API ---
    console.log('\n--- 1. Testing REST API Shares Discovery ---');
    const rShares = await httpRequest({ ...base, method: 'GET', path: '/api/shares', headers: authHeaders });
    ok('GET /api/shares returns 200', rShares.statusCode === 200);
    const sharesData = JSON.parse(rShares.body);
    ok('Shares list contains main-library', sharesData.shares.some((s) => s.id === 'main-library'));

    // --- 2. Test /api/list Directory Browsing ---
    console.log('\n--- 2. Testing Directory Browsing API ---');
    const rList = await httpRequest({ ...base, method: 'GET', path: '/api/list?shareId=main-library', headers: authHeaders });
    ok('GET /api/list returns 200', rList.statusCode === 200);
    const listData = JSON.parse(rList.body);
    ok('List items contains sample_video.mp4', listData.items.some((i) => i.name === 'sample_video.mp4'));
    ok('List items contains photos_2026 directory', listData.items.some((i) => i.name === 'photos_2026' && i.isDirectory));
    ok('List items contains Unicode filename', listData.items.some((i) => i.name.includes('中文文档_财务报表')));

    // --- 3. Test HTTP Range Request (Video Streaming Simulation) ---
    console.log('\n--- 3. Testing HTTP 206 Range Request (Video Streaming) ---');
    // First 1KB
    const rRange1 = await httpRequest({
      ...base,
      method: 'GET',
      path: '/webdav/main-library/sample_video.mp4',
      headers: { ...authHeaders, Range: 'bytes=0-1023' }
    });
    ok('Range bytes=0-1023 returns 206', rRange1.statusCode === 206);
    ok('Content-Range header correct', rRange1.headers['content-range'] === 'bytes 0-1023/51200');
    ok('Response body length is exactly 1024 bytes', rRange1.rawBody.length === 1024);

    // Mid-stream seek (bytes=20480-40959 -> 20KB seek)
    const rRange2 = await httpRequest({
      ...base,
      method: 'GET',
      path: '/webdav/main-library/sample_video.mp4',
      headers: { ...authHeaders, Range: 'bytes=20480-40959' }
    });
    ok('Range bytes=20480-40959 returns 206 (20KB seek)', rRange2.statusCode === 206);
    ok('Seek Content-Range header correct', rRange2.headers['content-range'] === 'bytes 20480-40959/51200');
    ok('Seek chunk body length is 20480 bytes', rRange2.rawBody.length === 20480);

    // Out of bounds Range returns 416
    const rRangeInvalid = await httpRequest({
      ...base,
      method: 'GET',
      path: '/webdav/main-library/sample_video.mp4',
      headers: { ...authHeaders, Range: 'bytes=99999-199999' }
    });
    ok('Out-of-bounds Range returns 416', rRangeInvalid.statusCode === 416);

    // --- 4. Test Web Upload with Unicode filename ---
    console.log('\n--- 4. Testing Web Upload ---');
    const uploadContent = Buffer.from('Uploaded document from web browser drag-and-drop 🚀');
    const uploadName = '浏览器拖拽上传_项目报告 📄.txt';
    const rUpload = await httpRequest({
      ...base,
      method: 'PUT',
      path: `/webdav/main-library/${encodeURIComponent(uploadName)}`,
      headers: { ...authHeaders, 'Content-Length': uploadContent.length }
    }, uploadContent);
    ok('Web Upload PUT returns 201', rUpload.statusCode === 201);
    ok('Uploaded file exists on disk', fs.existsSync(path.join(shareDir, uploadName)));

    // Verify download round-trip
    const rDown = await httpRequest({
      ...base,
      method: 'GET',
      path: `/webdav/main-library/${encodeURIComponent(uploadName)}`,
      headers: authHeaders
    });
    ok('Downloaded upload content matches bit-for-bit', rDown.rawBody.equals(uploadContent));

    // --- 5. Test SSE Live Event Stream ---
    console.log('\n--- 5. Testing SSE Real-time Filesystem Notifications ---');
    let sseReceived = false;
    const sseReq = https.request({
      ...base,
      path: '/api/events',
      method: 'GET',
      headers: authHeaders,
      rejectUnauthorized: false
    }, (res) => {
      res.on('data', (chunk) => {
        const text = chunk.toString('utf8');
        if (text.includes('event:') || text.includes('data:')) {
          sseReceived = true;
        }
      });
    });
    sseReq.end();

    // Trigger a filesystem change to cause SSE notification
    await new Promise((r) => setTimeout(r, 200));
    fs.writeFileSync(path.join(shareDir, 'sse_trigger.tmp'), 'trigger event');
    await new Promise((r) => setTimeout(r, 600));

    sseReq.destroy();
    ok('SSE connected and received real-time sync stream', sseReceived);

    console.log('======================================================');
    console.log(`  BROWSER PORTAL TESTS: ${passed} passed, ${failed} failed `);
    console.log('======================================================');
    if (failed > 0) process.exit(1);

  } finally {
    await service.close();
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
  }
}

main().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});

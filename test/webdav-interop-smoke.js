'use strict';

// Shared-library interop smoke test — exercises the implemented method set against a
// live DesktopLibraryService using Node's https client. Tests are black-box:
// they start the HTTPS server, mint a Bearer token, and issue standard WebDAV
// HTTP requests (PROPFIND/GET/PUT/DELETE/MKCOL/MOVE/OPTIONS) verifying representative
// method semantics, Depth handling, URL encoding, and ETag propagation.
//
// Run: node test/webdav-interop-smoke.js

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
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-webdav-interop-'));
  const shareDir = path.join(tempDir, 'share');
  fs.mkdirSync(shareDir);
  fs.writeFileSync(path.join(shareDir, 'hello.txt'), 'Hello WebDAV World');
  fs.mkdirSync(path.join(shareDir, 'subfolder'));
  fs.writeFileSync(path.join(shareDir, 'subfolder', 'nested.txt'), 'Nested Content');

  const peerStore = new MockTrustedPeerStore({
    'interop-peer': {
      deviceId: 'interop-peer',
      isTrusted: () => true,
      permissions: { libraryRead: true, libraryUpload: true, transfer: true }
    }
  });

  const service = new DesktopLibraryService({
    trustedPeerStore: peerStore,
    shares: [{ id: 'docs', name: 'Documents', localPath: shareDir, readOnly: false }]
  });

  const port = await service.start(0);
  const base = { host: '127.0.0.1', port };
  const token = service.createSessionToken('interop-peer');
  const authHeaders = { Authorization: `Bearer ${token}`, Host: '127.0.0.1' };

  console.log('WebDAV Interop Smoke Test');
  console.log(`  Server: https://127.0.0.1:${port}/docs/  (share=docs)`);
  console.log('');

  try {
    // ── Test 1: OPTIONS returns correct Allow and DAV headers ──────────────
    {
      const r = await httpRequest({ ...base, method: 'OPTIONS', path: '/docs/', headers: authHeaders });
      ok('OPTIONS returns 200', r.statusCode === 200, `got ${r.statusCode}`);
      const allow = r.headers.allow || '';
      ok('OPTIONS Allow includes MKCOL+DELETE+COPY+MOVE', allow.includes('MKCOL') && allow.includes('DELETE') && allow.includes('COPY') && allow.includes('MOVE'), allow);
      ok('OPTIONS MS-Author-Via is DAV', r.headers['ms-author-via'] === 'DAV', r.headers['ms-author-via']);
    }

    // ── Test 2: PROPFIND root returns multistatus XML with props ───────────
    {
      const r = await httpRequest({ ...base, method: 'PROPFIND', path: '/docs/', headers: { ...authHeaders, Depth: '1' } });
      ok('PROPFIND root returns 207', r.statusCode === 207, `got ${r.statusCode}`);
      ok('PROPFIND root returns XML', (r.headers['content-type'] || '').includes('xml'), r.headers['content-type']);
      ok('PROPFIND root has displayname', r.body.includes('D:displayname'));
      ok('PROPFIND root has getcontentlength', r.body.includes('D:getcontentlength'));
      ok('PROPFIND root has getlastmodified', r.body.includes('D:getlastmodified'));
      ok('PROPFIND root has resourcetype', r.body.includes('D:resourcetype'));
      ok('PROPFIND root has getetag', r.body.includes('D:getetag'));
      ok('PROPFIND root lists hello.txt', r.body.includes('hello.txt'));
    }

    // ── Test 3: PROPFIND subdirectory ──────────────────────────────────────
    {
      const r = await httpRequest({ ...base, method: 'PROPFIND', path: '/docs/subfolder/', headers: { ...authHeaders, Depth: '1' } });
      ok('PROPFIND subdir returns 207', r.statusCode === 207, `got ${r.statusCode}`);
      ok('PROPFIND subdir lists nested.txt', r.body.includes('nested.txt'));
    }

    // ── Test 4: PROPFIND with Depth: 0 returns no children ─────────────────
    {
      const r = await httpRequest({ ...base, method: 'PROPFIND', path: '/docs/', headers: { ...authHeaders, Depth: '0' } });
      ok('PROPFIND Depth:0 returns 207', r.statusCode === 207);
      ok('PROPFIND Depth:0 omits hello.txt', !r.body.includes('hello.txt'), 'children should be omitted');
    }

    // ── Test 5: GET file ────────────────────────────────────────────────────
    {
      const r = await httpRequest({ ...base, method: 'GET', path: '/docs/hello.txt', headers: authHeaders });
      ok('GET file returns 200', r.statusCode === 200, `got ${r.statusCode}`);
      ok('GET file content matches', r.body === 'Hello WebDAV World', r.body);
      ok('GET returns Accept-Ranges: bytes', r.headers['accept-ranges'] === 'bytes', r.headers['accept-ranges']);
      ok('GET returns ETag', !!r.headers.etag, r.headers.etag);

      // Range request verification (bytes=0-4 -> "Hello")
      const rangeReq = await httpRequest({ ...base, method: 'GET', path: '/docs/hello.txt', headers: { ...authHeaders, Range: 'bytes=0-4' } });
      ok('GET Range returns 206', rangeReq.statusCode === 206, `got ${rangeReq.statusCode}`);
      ok('GET Range content matches', rangeReq.body === 'Hello', `got ${rangeReq.body}`);
      ok('GET Range Content-Range header present', (rangeReq.headers['content-range'] || '').startsWith('bytes 0-4/'), rangeReq.headers['content-range']);
    }

    // ── Test 6: PUT upload (Content-Length) ─────────────────────────────────
    {
      const body = 'Uploaded via WebDAV PUT';
      const r = await httpRequest({ ...base, method: 'PUT', path: '/docs/uploaded.txt', headers: { ...authHeaders, 'Content-Length': Buffer.byteLength(body) } }, body);
      ok('PUT upload returns 201', r.statusCode === 201, `got ${r.statusCode}`);
      const g = await httpRequest({ ...base, method: 'GET', path: '/docs/uploaded.txt', headers: authHeaders });
      ok('PUT file content round-trips', g.body === body, g.body);
    }

    // ── Test 7: MKCOL create directory ─────────────────────────────────────
    {
      const r = await httpRequest({ ...base, method: 'MKCOL', path: '/docs/newdir/', headers: authHeaders });
      ok('MKCOL returns 201', r.statusCode === 201, `got ${r.statusCode}`);
      ok('MKCOL directory exists on disk', fs.existsSync(path.join(shareDir, 'newdir')));
    }

    // ── Test 8: MOVE rename ────────────────────────────────────────────────
    {
      const r = await httpRequest({ ...base, method: 'MOVE', path: '/docs/uploaded.txt', headers: { ...authHeaders, Destination: `https://127.0.0.1:${port}/docs/renamed.txt`, Overwrite: 'T' } });
      ok('MOVE returns 201/204', r.statusCode === 201 || r.statusCode === 204, `got ${r.statusCode}`);
      ok('MOVE source gone', !fs.existsSync(path.join(shareDir, 'uploaded.txt')));
      ok('MOVE destination exists', fs.existsSync(path.join(shareDir, 'renamed.txt')));
    }

    // ── Test 9: DELETE ──────────────────────────────────────────────────────
    {
      const r = await httpRequest({ ...base, method: 'DELETE', path: '/docs/renamed.txt', headers: authHeaders });
      ok('DELETE returns 204', r.statusCode === 204, `got ${r.statusCode}`);
      ok('DELETE file gone from disk', !fs.existsSync(path.join(shareDir, 'renamed.txt')));
    }

    // ── Test 10: URL encoding — Chinese filename round-trip ────────────────
    {
      const chineseName = '测试文件.txt';
      const encodedName = encodeURIComponent(chineseName);
      const body = 'Chinese filename content';
      const pu = await httpRequest({ ...base, method: 'PUT', path: `/docs/${encodedName}`, headers: { ...authHeaders, 'Content-Length': Buffer.byteLength(body) } }, body);
      ok('PUT Chinese filename returns 201', pu.statusCode === 201, `got ${pu.statusCode}`);
      const pf = await httpRequest({ ...base, method: 'PROPFIND', path: `/docs/${encodedName}`, headers: { ...authHeaders, Depth: '0' } });
      ok('PROPFIND Chinese filename returns 207', pf.statusCode === 207, `got ${pf.statusCode}`);
      const gf = await httpRequest({ ...base, method: 'GET', path: `/docs/${encodedName}`, headers: authHeaders });
      ok('GET Chinese filename content matches', gf.body === body, gf.body);
      // Verify the PROPFIND root lists the encoded href
      const pr = await httpRequest({ ...base, method: 'PROPFIND', path: '/docs/', headers: { ...authHeaders, Depth: '1' } });
      ok('PROPFIND root lists encoded Chinese href', pr.body.includes(encodedName), `expected ${encodedName} in response`);
    }

    // ── Test 11: Unauthorized request returns 401 ──────────────────────────
    {
      const r = await httpRequest({ ...base, method: 'PROPFIND', path: '/docs/', headers: { Depth: '1' } });
      ok('Unauthenticated PROPFIND returns 401', r.statusCode === 401, `got ${r.statusCode}`);
      ok('401 has WWW-Authenticate Bearer', (r.headers['www-authenticate'] || '').includes('Bearer'), r.headers['www-authenticate']);
    }

    // ── Test 12: Path traversal is blocked ─────────────────────────────────
    {
      const r = await httpRequest({ ...base, method: 'GET', path: '/docs/../../../etc/passwd', headers: authHeaders });
      ok('Path traversal returns 403', r.statusCode === 403, `got ${r.statusCode}`);
    }
  } finally {
    await service.stop();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  console.log('');
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) { process.exit(1); }
  console.log('  ALL WEBDAV INTEROP TESTS PASSED');
}

main().catch((err) => { console.error('FATAL:', err); process.exit(1); });

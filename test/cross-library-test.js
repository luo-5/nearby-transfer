'use strict';

// Cross-machine shared library (WebDAV) test client.
// Tests: authenticate → list shares → PROPFIND → PUT (upload) → GET (download) → verify SHA256 → DELETE.
//
// Usage:
//   node test/cross-library-test.js --host 192.168.105.1 --port 56578 \
//     --identity-file /tmp/nt-sender-id.json --peer-identity-file /tmp/nt-recv-identity.json
//
// The library server runs on the machine whose identity is in --peer-identity-file
// (the "receiver" identity from the transfer tests, which has libraryRead + libraryUpload
// permissions when pre-seeded as a trusted peer). The client uses --identity-file
// (its own device with signing keys) to sign the auth payload.

const crypto = require('crypto');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createKeyPair, createX25519KeyPair, fingerprintFor } = require('../src/core/crypto');

function loadIdentity(args) {
  const idfile = args['identity-file'];
  if (!idfile) throw new Error('--identity-file required');
  const raw = fs.readFileSync(idfile, 'utf8');
  const lines = raw.split('\n');
  const idLine = lines.find((l) => l.includes('"DEVICE_IDENTITY"')) || lines[0];
  const parsed = JSON.parse(idLine);
  return parsed;
}

function loadPeerIdentity(args) {
  const pfile = args['peer-identity-file'];
  if (!pfile) throw new Error('--peer-identity-file required');
  const raw = fs.readFileSync(pfile, 'utf8');
  // Could be SENDER_IDENTITY, RECEIVER_IDENTITY, or DEVICE_IDENTITY
  const parsed = JSON.parse(raw.trim().split('\n')[0]);
  return parsed;
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const val = argv[i + 1];
      if (val && !val.startsWith('--')) { args[key] = val; i++; }
      else args[key] = true;
    }
  }
  return args;
}

function httpRequest(host, port, method, urlPath, headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    const opts = { hostname: host, port, method, path: urlPath, headers, rejectUnauthorized: false };
    const req = https.request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        resolve({ status: res.statusCode, headers: res.headers, body: buf });
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(new Error('timeout')); });
    if (body) req.write(body);
    req.end();
  });
}

async function authenticate(host, port, device) {
  const timestamp = Date.now().toString();
  const nonce = crypto.randomBytes(16).toString('hex');
  const authPayload = `nearby-transfer:library-auth:${device.deviceId}:${timestamp}:${nonce}`;
  const privateKey = crypto.createPrivateKey(device.signingPrivateKey);
  const signature = crypto.sign(null, Buffer.from(authPayload, 'utf8'), privateKey).toString('base64');

  const resp = await httpRequest(host, port, 'POST', '/api/auth', {
    'Content-Type': 'application/json'
  }, JSON.stringify({ deviceId: device.deviceId, timestamp, nonce, signature }));

  if (resp.status !== 200) {
    throw new Error(`Auth failed: ${resp.status} ${resp.body.toString()}`);
  }
  const data = JSON.parse(resp.body.toString());
  if (!data.ok) throw new Error(`Auth failed: ${data.error}`);
  return data; // { ok, token, shares, expiresIn }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const host = args.host;
  const port = parseInt(args.port || '56578', 10);

  if (!host || !args['identity-file']) {
    console.error('Usage: node test/cross-library-test.js --host <ip> --port <port> --identity-file <path> --peer-identity-file <path>');
    process.exit(1);
  }

  const device = loadIdentity(args);
  console.log(JSON.stringify({ type: 'INFO', msg: `library test client deviceId=${device.deviceId} -> ${host}:${port}` }));

  const results = { steps: [] };
  const startTime = Date.now();

  try {
    // Step 1: Authenticate
    console.log(JSON.stringify({ type: 'INFO', msg: 'authenticating...' }));
    const auth = await authenticate(host, port, device);
    const token = auth.token;
    console.log(JSON.stringify({ type: 'INFO', msg: `auth ok, token=${token.slice(0, 8)}..., shares=${auth.shares.length}` }));
    results.steps.push({ step: 'auth', result: 'pass', shares: auth.shares.length });

    const authHeader = { 'Authorization': `Bearer ${token}` };
    const shareId = auth.shares[0]?.id || 'default-share';

    // Step 2: List shares via API
    const sharesResp = await httpRequest(host, port, 'GET', '/api/shares', authHeader);
    const sharesData = JSON.parse(sharesResp.body.toString());
    if (sharesResp.status !== 200 || !sharesData.ok) {
      throw new Error(`List shares failed: ${sharesResp.status}`);
    }
    console.log(JSON.stringify({ type: 'INFO', msg: `shares: ${sharesData.shares.map(s => s.id).join(', ')}` }));
    results.steps.push({ step: 'list-shares', result: 'pass' });

    // Step 3: List files via API
    const listResp = await httpRequest(host, port, 'GET', `/api/list?shareId=${shareId}`, authHeader);
    if (listResp.status !== 200) {
      throw new Error(`List files failed: ${listResp.status}`);
    }
    const listData = JSON.parse(listResp.body.toString());
    console.log(JSON.stringify({ type: 'INFO', msg: `files in share root: ${listData.items?.length || 0}` }));
    results.steps.push({ step: 'list-files', result: 'pass', count: listData.items?.length || 0 });

    // Step 4: PROPFIND root
    const propfindResp = await httpRequest(host, port, 'PROPFIND', '/', { ...authHeader, 'Depth': '1' });
    if (propfindResp.status !== 207) {
      throw new Error(`PROPFIND failed: ${propfindResp.status}`);
    }
    console.log(JSON.stringify({ type: 'INFO', msg: `PROPFIND root: ${propfindResp.body.toString().length} bytes XML` }));
    results.steps.push({ step: 'propfind', result: 'pass' });

    // Step 5: Upload a test file via PUT
    const testData = crypto.randomBytes(1024 * 100); // 100KB
    const testSha = crypto.createHash('sha256').update(testData).digest('hex');
    const uploadName = `lib-test-${device.deviceId.slice(0, 8)}-${Date.now()}.bin`;
    const uploadPath = `/webdav/${shareId}/${uploadName}`;

    const putResp = await httpRequest(host, port, 'PUT', uploadPath, {
      ...authHeader,
      'Content-Type': 'application/octet-stream',
      'Content-Length': testData.length
    }, testData);

    if (putResp.status !== 201 && putResp.status !== 200) {
      throw new Error(`PUT upload failed: ${putResp.status} ${putResp.body.toString()}`);
    }
    console.log(JSON.stringify({ type: 'INFO', msg: `uploaded ${uploadName} (${testData.length} bytes, sha=${testSha.slice(0, 16)}...)` }));
    results.steps.push({ step: 'upload', result: 'pass', name: uploadName, sha256: testSha });

    // Step 6: Download the file via GET and verify SHA256
    const getResp = await httpRequest(host, port, 'GET', uploadPath, authHeader);
    if (getResp.status !== 200) {
      throw new Error(`GET download failed: ${getResp.status}`);
    }
    const downloadedSha = crypto.createHash('sha256').update(getResp.body).digest('hex');
    if (downloadedSha !== testSha) {
      throw new Error(`SHA256 mismatch: uploaded=${testSha} downloaded=${downloadedSha}`);
    }
    console.log(JSON.stringify({ type: 'INFO', msg: `downloaded ${uploadName}, SHA256 match ✓` }));
    results.steps.push({ step: 'download-verify', result: 'pass', sha256_match: true });

    // Step 7: Delete the test file
    const delResp = await httpRequest(host, port, 'DELETE', uploadPath, authHeader);
    if (delResp.status !== 200 && delResp.status !== 204) {
      console.log(JSON.stringify({ type: 'WARN', msg: `DELETE returned ${delResp.status} (non-fatal)` }));
    } else {
      console.log(JSON.stringify({ type: 'INFO', msg: `deleted ${uploadName}` }));
    }
    results.steps.push({ step: 'delete', result: delResp.status < 300 ? 'pass' : 'warn' });

    // All done
    results.overall = 'pass';
    results.durationMs = Date.now() - startTime;
    console.log(JSON.stringify({ type: 'RESULT', role: 'library-client', result: 'ok', ...results }));

  } catch (error) {
    results.overall = 'fail';
    results.error = error.message;
    results.durationMs = Date.now() - startTime;
    console.log(JSON.stringify({ type: 'RESULT', role: 'library-client', result: 'fail', ...results }));
    process.exit(1);
  }
}

main().catch((error) => {
  console.log(JSON.stringify({ type: 'FATAL', error: error.message, stack: error.stack }));
  process.exit(1);
});

'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const { ProtocolEngine, PROTOCOLS, CATEGORIES } = require('../src/protocols/protocol-engine');

console.log('======================================================');
console.log('     TESTING PROTOCOL ENGINE & 7 DRIVER DISPATCH      ');
console.log('======================================================');

const engine = new ProtocolEngine();

// 1. Verify all 7 drivers are registered
const allProtocols = engine.listProtocols();
assert.strictEqual(allProtocols.length, 7, 'Must have 7 registered protocols');
console.log(`[PASS] 1. All 7 protocol drivers loaded successfully (${allProtocols.length} drivers).`);

// 2. Category filtering verification
const fastList = engine.listProtocols(CATEGORIES.FAST);
const systemList = engine.listProtocols(CATEGORIES.SYSTEM);
const standardList = engine.listProtocols(CATEGORIES.STANDARD);

assert.strictEqual(fastList.length, 3, 'Fast category must contain 3 protocols (v2, turbo, quic)');
assert.strictEqual(systemList.length, 2, 'System category must contain 2 protocols (smb, webdav)');
assert.strictEqual(standardList.length, 2, 'Standard category must contain 2 protocols (v1, ftps)');
console.log('[PASS] 2. Category filtering verified across fast, system, and standard categories!');

// 3. Test Turbo Parallel slice calculation
const turboDriver = engine.get(PROTOCOLS.TURBO_PARALLEL);
const slices100MB = turboDriver.calculateSlices(100 * 1024 * 1024, 4);
assert.strictEqual(slices100MB.length, 4, '100MB file should produce 4 slices for 4 streams');
assert.strictEqual(slices100MB[0].start, 0);
assert.strictEqual(slices100MB[3].end, 100 * 1024 * 1024);
console.log('[PASS] 3. Turbo Parallel stream slice calculation verified!');

// 4. Test SMB Share URI formatting across platforms
const smbDriver = engine.get(PROTOCOLS.SMB_SHARE);
const winUri = smbDriver.getShareUri('192.168.1.50', 'Photos', 'win32');
const macUri = smbDriver.getShareUri('192.168.1.50', 'Photos', 'darwin');
assert.strictEqual(winUri, '\\\\192.168.1.50\\Photos');
assert.strictEqual(macUri, 'smb://192.168.1.50/Photos');
console.log('[PASS] 4. SMB 3.0 multi-platform URI generation verified!');

// 5. Test Hot Protocol Switching & Dispatch Execution
const dummyPeer = { id: 'peer-test', ip: '192.168.1.100' };

async function testAllDrivers() {
  for (const protoId of Object.values(PROTOCOLS)) {
    const switchRes = await engine.setActiveProtocol(protoId);
    assert(switchRes.ok, `Switching to ${protoId} failed`);
    assert.strictEqual(engine.activeProtocol, protoId);

    const sendRes = await engine.sendFile(dummyPeer, 'dummy-test-file.zip', { fileSize: 10 * 1024 * 1024 });
    assert(sendRes.ok, `SendFile failed for ${protoId}`);
    assert.strictEqual(sendRes.protocol, protoId);
  }
}

testAllDrivers().then(() => {
  console.log('[PASS] 5. Registry selection and driver interface dispatch verified for all 7 definitions.');
  console.log('======================================================');
  console.log('       PROTOCOL ENGINE SMOKE TESTS PASSED             ');
  console.log('======================================================');
}).catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});

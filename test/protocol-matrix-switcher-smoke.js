'use strict';

const assert = require('assert');
const {
  DEFAULT_TRANSFER_PROTOCOL,
  getProtocolAvailability,
  listProtocolAvailability,
  normalizeTransferProtocol,
  validateTransferProtocol
} = require('../src/protocols/availability');

console.log('======================================================');
console.log('       TESTING PROTOCOL AVAILABILITY MATRIX           ');
console.log('======================================================');

const ALLOWED_PROTOCOLS = [
  'v2-stream',
  'turbo-parallel',
  'quic-udp',
  'smb-share',
  'webdav-sync',
  'v1-classic',
  'ftps-secure'
];

// 1. Verify all 7 protocol definitions in translations (zh + en)
const { translations } = require('../src/renderer/i18n');

assert(translations.zh, 'zh translations must exist');
assert(translations.en, 'en translations must exist');

const requiredKeys = [
  'protocol_settings_title',
  'protocol_settings_subtitle',
  'protocol_category_all',
  'protocol_category_fast',
  'protocol_category_system',
  'protocol_category_standard',
  'protocol_v2_name',
  'protocol_turbo_name',
  'protocol_quic_name',
  'protocol_smb_name',
  'protocol_webdav_name',
  'protocol_v1_name',
  'protocol_ftps_name'
];

for (const key of requiredKeys) {
  assert(translations.zh[key], `zh missing translation for: ${key}`);
  assert(translations.en[key], `en missing translation for: ${key}`);
}
console.log('[PASS] 1. All 7 protocol translations and categories verified in i18n dictionary!');

// 2. The selector must fail closed until a driver is connected to the real
// desktop send/receive path. Stale settings normalize to the wired default.
assert.strictEqual(DEFAULT_TRANSFER_PROTOCOL, 'v1-classic');
assert.strictEqual(listProtocolAvailability().length, ALLOWED_PROTOCOLS.length);

for (const p of ALLOWED_PROTOCOLS) {
  const availability = getProtocolAvailability(p);
  assert(availability, `Missing availability metadata for ${p}`);
  if (p === DEFAULT_TRANSFER_PROTOCOL) {
    assert.strictEqual(availability.available, true);
    assert.deepStrictEqual(validateTransferProtocol(p), { ok: true, protocol: p });
  } else {
    assert.strictEqual(availability.available, false);
    assert.strictEqual(validateTransferProtocol(p).code, 'PROTOCOL_EXPERIMENTAL');
    assert.strictEqual(normalizeTransferProtocol(p), DEFAULT_TRANSFER_PROTOCOL);
  }
}
assert.strictEqual(normalizeTransferProtocol('not-a-protocol'), DEFAULT_TRANSFER_PROTOCOL);
assert.strictEqual(validateTransferProtocol('not-a-protocol').code, 'PROTOCOL_UNKNOWN');

const mutableEntry = getProtocolAvailability(DEFAULT_TRANSFER_PROTOCOL);
mutableEntry.available = false;
assert.strictEqual(getProtocolAvailability(DEFAULT_TRANSFER_PROTOCOL).available, true);

console.log('[PASS] 2. Experimental protocols are rejected and stale settings fail closed.');

console.log('======================================================');
console.log('    PROTOCOL AVAILABILITY SMOKE TESTS PASSED          ');
console.log('======================================================');

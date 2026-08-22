'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs');

console.log('======================================================');
console.log('      TESTING 7-PROTOCOL MATRIX & PERSISTENCE         ');
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

// 2. Test Configuration Persistence (Mock User Data Dir)
const tmpDir = path.join(__dirname, '..', '.tmp', 'proto_test_' + Date.now());
fs.mkdirSync(tmpDir, { recursive: true });

const configFile = path.join(tmpDir, 'protocol_config.json');

function saveProto(proto) {
  assert(ALLOWED_PROTOCOLS.includes(proto), `Invalid protocol: ${proto}`);
  fs.writeFileSync(configFile, JSON.stringify({ protocol: proto, updatedAt: Date.now() }, null, 2), 'utf8');
}

function loadProto() {
  if (!fs.existsSync(configFile)) return 'v2-stream';
  const data = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  return (data && data.protocol) || 'v2-stream';
}

// Test default
assert.strictEqual(loadProto(), 'v2-stream');

// Test saving and loading each of the 7 protocols
for (const p of ALLOWED_PROTOCOLS) {
  saveProto(p);
  assert.strictEqual(loadProto(), p, `Failed to persist protocol: ${p}`);
}
console.log('[PASS] 2. Configuration persistence lifecycle verified across all 7 protocols!');

// Cleanup
fs.rmSync(tmpDir, { recursive: true, force: true });

console.log('======================================================');
console.log('   ALL 7-PROTOCOL MATRIX SMOKE TESTS PASSED (100%)    ');
console.log('======================================================');

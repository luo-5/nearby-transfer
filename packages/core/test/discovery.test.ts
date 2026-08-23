/**
 * Discovery layer tests for @nearby-transfer/core.
 *
 * Tests announcement creation, signing, verification, datagram parsing, and
 * multicast-interface enumeration. The full V2Discovery socket lifecycle is
 * exercised by the desktop smoke tests; here we validate the protocol logic.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';

import {
  createEd25519KeyPair,
  createX25519KeyPair,
  deriveDeviceId,
  fingerprintFor,
  createDiscoveryAnnouncement,
  signDiscoveryAnnouncement,
  verifyDiscoveryAnnouncement,
  parseDiscoveryDatagram,
  assertValidDiscoveryAnnouncement,
  assertFreshDiscoveryAnnouncement,
  discoveryAnnouncementSigningPayload,
  multicastInterfaces,
  parseOverride,
  isIpv4Address,
  canonicalJson,
  MULTICAST_ADDRESS,
  DISCOVERY_PORT,
  MAX_ANNOUNCEMENT_BYTES,
} from '../src/index.js';
import type { DiscoveryDevice } from '../src/index.js';

function makeDevice(): DiscoveryDevice {
  const signing = createEd25519KeyPair();
  const encryption = createX25519KeyPair();
  const deviceId = deriveDeviceId(signing.publicKey);
  const fingerprint = fingerprintFor(signing.publicKey);
  return {
    deviceId,
    deviceName: 'test-device',
    fingerprint,
    signingPublicKey: signing.publicKey,
    encryptionPublicKey: encryption.publicKey,
    signingPrivateKey: signing.privateKey,
  };
}

test('discovery: createDiscoveryAnnouncement produces a valid announcement', () => {
  const device = makeDevice();
  const announcement = createDiscoveryAnnouncement({
    device,
    port: 47777,
    capabilities: ['v2-stream'],
    issuedAt: 1700000000000,
  });
  assert.equal(announcement.app, 'nearby-transfer');
  assert.equal(announcement.protocolVersion, 2);
  assert.equal(announcement.type, 'discovery-announce');
  assert.equal(announcement.identity.deviceId, device.deviceId);
  assert.equal(announcement.identity.fingerprint, device.fingerprint);
  assert.deepEqual(announcement.capabilities, ['v2-stream']);
  assert.doesNotThrow(() => assertValidDiscoveryAnnouncement(announcement));
});

test('discovery: sign and verify round-trips', () => {
  const device = makeDevice();
  const announcement = createDiscoveryAnnouncement({ device, port: 47777 });
  const signature = signDiscoveryAnnouncement(announcement, device.signingPrivateKey);
  assert.equal(verifyDiscoveryAnnouncement(announcement, signature), true);
  // Tampered signature fails
  assert.equal(verifyDiscoveryAnnouncement(announcement, 'aW52YWxpZA=='), false);
  // Missing signature fails
  assert.equal(verifyDiscoveryAnnouncement(announcement, undefined), false);
});

test('discovery: signing payload is canonical and deterministic', () => {
  const device = makeDevice();
  const ann = createDiscoveryAnnouncement({ device, port: 47777, capabilities: ['b', 'a'], issuedAt: 100 });
  const payload1 = discoveryAnnouncementSigningPayload(ann);
  const payload2 = discoveryAnnouncementSigningPayload(ann);
  assert.equal(payload1, payload2);
  // capabilities are sorted in canonical form
  assert.ok(payload1.includes('"capabilities":["a","b"]'));
});

test('discovery: parseDiscoveryDatagram round-trips a signed announcement', () => {
  const device = makeDevice();
  const announcement = createDiscoveryAnnouncement({ device, port: 47777, capabilities: ['v2-stream'] });
  const signature = signDiscoveryAnnouncement(announcement, device.signingPrivateKey);
  const datagram = Buffer.from(
    canonicalJson({ ...announcement, signature }),
    'utf8',
  );
  const parsed = parseDiscoveryDatagram(datagram);
  assert.equal(parsed.identity.deviceId, device.deviceId);
  assert.equal(parsed.signature, signature);
  assert.equal(verifyDiscoveryAnnouncement(parsed, parsed.signature), true);
});

test('discovery: parseDiscoveryDatagram rejects oversized datagrams', () => {
  assert.throws(
    () => parseDiscoveryDatagram(Buffer.alloc(MAX_ANNOUNCEMENT_BYTES + 1)),
    /exceeds the accepted bounds/,
  );
  assert.throws(() => parseDiscoveryDatagram(Buffer.alloc(0)), /exceeds the accepted bounds/);
});

test('discovery: parseDiscoveryDatagram rejects non-canonical JSON', () => {
  const device = makeDevice();
  const announcement = createDiscoveryAnnouncement({ device, port: 47777 });
  const signature = signDiscoveryAnnouncement(announcement, device.signingPrivateKey);
  // Add extra whitespace -> non-canonical
  const datagram = Buffer.from('{ "app": "nearby-transfer" }', 'utf8');
  assert.throws(() => parseDiscoveryDatagram(datagram), /canonical/);
});

test('discovery: assertFreshDiscoveryAnnouncement rejects stale announcements', () => {
  const device = makeDevice();
  const now = Date.now();
  const announcement = createDiscoveryAnnouncement({ device, port: 47777, issuedAt: now - 60000 });
  assert.throws(() => assertFreshDiscoveryAnnouncement(announcement, now), /stale/);
  // Fresh announcement passes
  const fresh = createDiscoveryAnnouncement({ device, port: 47777, issuedAt: now });
  assert.doesNotThrow(() => assertFreshDiscoveryAnnouncement(fresh, now));
});

test('discovery: multicastInterfaces returns an array (may be empty in CI)', () => {
  const interfaces = multicastInterfaces();
  assert.ok(Array.isArray(interfaces));
  // Every returned address is a valid IPv4
  for (const addr of interfaces) {
    assert.equal(isIpv4Address(addr), true);
  }
});

test('discovery: parseOverride handles comma-separated and empty', () => {
  assert.deepEqual(parseOverride('192.168.1.1,10.0.0.1'), ['10.0.0.1', '192.168.1.1']);
  assert.deepEqual(parseOverride(''), []);
  assert.deepEqual(parseOverride(undefined), []);
  assert.deepEqual(parseOverride('not-an-ip'), []);
});

test('discovery: constants match protocol', () => {
  assert.equal(MULTICAST_ADDRESS, '239.255.77.77');
  assert.equal(DISCOVERY_PORT, 47777);
});

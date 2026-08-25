import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import {
  createDiscoveryAnnouncement,
  parseDiscoveryDatagram,
  verifyDiscoveryAnnouncement,
  signDiscoveryAnnouncement,
  assertFreshDiscoveryAnnouncement,
  DISCOVERY_MAX_CLOCK_SKEW_MS,
  MAX_ANNOUNCEMENT_BYTES,
} from '../src/discovery/index.js';
import { createEd25519KeyPair, createX25519KeyPair, deriveDeviceId, fingerprintFor } from '../src/crypto/identity.js';

describe('discovery edge tests', () => {
  const edPair = createEd25519KeyPair();
  const xPair = createX25519KeyPair();
  const device = {
    deviceId: deriveDeviceId(edPair.publicKey),
    deviceName: 'test-device',
    fingerprint: fingerprintFor(edPair.publicKey),
    signingPublicKey: edPair.publicKey,
    encryptionPublicKey: xPair.publicKey,
    signingPrivateKey: edPair.privateKey,
  };

  it('rejects stale or future-dated discovery announcements', () => {
    const now = 1000000000000;
    const freshAnn = createDiscoveryAnnouncement({ device, port: 47777, issuedAt: now });
    assert.doesNotThrow(() => assertFreshDiscoveryAnnouncement(freshAnn, now));

    // Stale (> 30s in the past)
    const staleAnn = createDiscoveryAnnouncement({ device, port: 47777, issuedAt: now - DISCOVERY_MAX_CLOCK_SKEW_MS - 1000 });
    assert.throws(() => assertFreshDiscoveryAnnouncement(staleAnn, now), /stale|clock/i);

    // Too far in the future (> 30s ahead)
    const futureAnn = createDiscoveryAnnouncement({ device, port: 47777, issuedAt: now + DISCOVERY_MAX_CLOCK_SKEW_MS + 1000 });
    assert.throws(() => assertFreshDiscoveryAnnouncement(futureAnn, now), /stale|clock/i);
  });

  it('rejects datagram exceeding max announcement bytes or empty', () => {
    assert.throws(() => parseDiscoveryDatagram(Buffer.alloc(0)), /bounds/i);
    assert.throws(() => parseDiscoveryDatagram(Buffer.alloc(MAX_ANNOUNCEMENT_BYTES + 1)), /bounds/i);
  });

  it('rejects announcements with tampered signatures', () => {
    const announcement = createDiscoveryAnnouncement({ device, port: 47777 });
    const sig = signDiscoveryAnnouncement(announcement, device.signingPrivateKey);

    assert.equal(verifyDiscoveryAnnouncement(announcement, sig), true);

    // Corrupt signature
    const corruptSig = sig.slice(0, -4) + 'AAAA';
    assert.equal(verifyDiscoveryAnnouncement(announcement, corruptSig), false);

    // Corrupt announcement field (e.g. port)
    const tamperedAnn = { ...announcement, port: 8080 };
    assert.equal(verifyDiscoveryAnnouncement(tamperedAnn, sig), false);
  });

  it('rejects announcements with malformed or missing envelopes', () => {
    const announcement = createDiscoveryAnnouncement({ device, port: 47777 });
    const invalidApp = { ...announcement, app: 'wrong-app' };
    assert.throws(() => parseDiscoveryDatagram(Buffer.from(JSON.stringify(invalidApp))), /envelope|canonical|JSON/i);
  });
});

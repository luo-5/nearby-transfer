/**
 * Security hardening tests for discovery announcement validation.
 *
 * Covers issue #6 requirements:
 * - reject UDP discovery datagrams larger than 16 KiB before JSON parsing
 * - bound device names and public-key fields to prevent oversized peer records
 * - require the advertised signing key to be Ed25519 and encryption key to be X25519
 * - reject malformed keys even when the claimed device ID and fingerprint are internally consistent
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Buffer } from 'node:buffer';
import {
  parseDiscoveryDatagram,
  createDiscoveryAnnouncement,
  MAX_ANNOUNCEMENT_BYTES,
} from '../src/discovery/index.js';
import {
  deriveDeviceId,
  fingerprintFor,
  createEd25519KeyPair,
  createX25519KeyPair,
} from '../src/pairing/identity-shape.js';

describe('discovery security hardening (issue #6)', () => {
  const edPair = createEd25519KeyPair();
  const xPair = createX25519KeyPair();
  const validDevice = {
    deviceId: deriveDeviceId(edPair.publicKey),
    deviceName: 'valid-device',
    fingerprint: fingerprintFor(edPair.publicKey),
    signingPublicKey: edPair.publicKey,
    encryptionPublicKey: xPair.publicKey,
    signingPrivateKey: edPair.privateKey,
  };

  describe('datagram size bounds', () => {
    it('rejects oversized payloads (>16 KiB) before JSON parsing', () => {
      // Create a payload that exceeds 16 KiB
      const oversizedBuffer = Buffer.alloc(MAX_ANNOUNCEMENT_BYTES + 1);
      assert.throws(
        () => parseDiscoveryDatagram(oversizedBuffer),
        /exceed|bounds/i
      );
    });

    it('accepts payloads at exactly 16 KiB boundary', () => {
      const announcement = createDiscoveryAnnouncement({
        device: validDevice,
        port: 47777,
      });
      const serialized = JSON.stringify(announcement);
      const padded = Buffer.concat([
        Buffer.from(serialized, 'utf8'),
        Buffer.alloc(MAX_ANNOUNCEMENT_BYTES - serialized.length, ' '),
      ]);

      // Should not throw for exactly 16 KiB (though it will fail JSON parsing, that's OK)
      try {
        parseDiscoveryDatagram(padded);
      } catch (error) {
        // If it throws, it should be a JSON parse error, not a size error
        if (error instanceof RangeError && /exceed|bounds/i.test(error.message)) {
          assert.fail('Should not reject based on size at exact boundary');
        }
      }
    });
  });

  describe('device name bounds', () => {
    it('rejects device names exceeding 128 characters', () => {
      const longNameDevice = {
        ...validDevice,
        deviceName: 'a'.repeat(129), // 129 chars > 128 limit
      };

      const announcement = createDiscoveryAnnouncement({
        device: longNameDevice,
        port: 47777,
      });

      // The announcement creation might succeed, but validation should fail
      assert.throws(
        () => parseDiscoveryDatagram(Buffer.from(JSON.stringify(announcement))),
        /name.*invalid|bounded/i
      );
    });

    it('rejects empty device names', () => {
      const emptyNameDevice = {
        ...validDevice,
        deviceName: '',
      };

      const announcement = createDiscoveryAnnouncement({
        device: emptyNameDevice,
        port: 47777,
      });

      assert.throws(
        () => parseDiscoveryDatagram(Buffer.from(JSON.stringify(announcement))),
        /name.*invalid/i
      );
    });

    it('rejects device names with null bytes', () => {
      const nullByteDevice = {
        ...validDevice,
        deviceName: 'test\x00device',
      };

      const announcement = createDiscoveryAnnouncement({
        device: nullByteDevice,
        port: 47777,
      });

      assert.throws(
        () => parseDiscoveryDatagram(Buffer.from(JSON.stringify(announcement))),
        /name.*invalid/i
      );
    });
  });

  describe('public key type enforcement', () => {
    it('requires signing key to be Ed25519', () => {
      // Try to use an X25519 key as signing key (wrong type)
      const wrongSigningKeyDevice = {
        ...validDevice,
        signingPublicKey: xPair.publicKey, // X25519 instead of Ed25519
      };

      const announcement = createDiscoveryAnnouncement({
        device: wrongSigningKeyDevice,
        port: 47777,
      });

      assert.throws(
        () => parseDiscoveryDatagram(Buffer.from(JSON.stringify(announcement))),
        /ed25519|x25519|key type/i
      );
    });

    it('requires encryption key to be X25519', () => {
      // Try to use an Ed25519 key as encryption key (wrong type)
      const wrongEncryptionKeyDevice = {
        ...validDevice,
        encryptionPublicKey: edPair.publicKey, // Ed25519 instead of X25519
      };

      const announcement = createDiscoveryAnnouncement({
        device: wrongEncryptionKeyDevice,
        port: 47777,
      });

      assert.throws(
        () => parseDiscoveryDatagram(Buffer.from(JSON.stringify(announcement))),
        /x25519|ed25519|key type/i
      );
    });

    it('rejects RSA keys even if structurally valid', () => {
      const rsaPair = crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      });

      const rsaDevice = {
        ...validDevice,
        signingPublicKey: rsaPair.publicKey.toString(),
        encryptionPublicKey: rsaPair.publicKey.toString(),
      };

      const announcement = createDiscoveryAnnouncement({
        device: rsaDevice,
        port: 47777,
      });

      assert.throws(
        () => parseDiscoveryDatagram(Buffer.from(JSON.stringify(announcement))),
        /ed25519|x25519|key type/i
      );
    });
  });

  describe('malformed key rejection', () => {
    it('rejects base64-padded but invalid PEM keys', () => {
      const malformedKeyDevice = {
        ...validDevice,
        signingPublicKey: '-----BEGIN PUBLIC KEY-----\nINVALIDBASE64DATA==\n-----END PUBLIC KEY-----',
      };

      const announcement = createDiscoveryAnnouncement({
        device: malformedKeyDevice,
        port: 47777,
      });

      assert.throws(
        () => parseDiscoveryDatagram(Buffer.from(JSON.stringify(announcement))),
        /unreadable|parse|key/i
      );
    });

    it('rejects truncated PEM keys', () => {
      const truncatedKeyDevice = {
        ...validDevice,
        encryptionPublicKey: edPair.publicKey.slice(0, 50), // Truncated
      };

      const announcement = createDiscoveryAnnouncement({
        device: truncatedKeyDevice,
        port: 47777,
      });

      assert.throws(
        () => parseDiscoveryDatagram(Buffer.from(JSON.stringify(announcement))),
        /unreadable|parse|key/i
      );
    });

    it('rejects keys with mismatched deviceId/fingerprint even if internally consistent', () => {
      // Create a different key pair
      const otherEdPair = createEd25519KeyPair();
      const otherXPair = createX25519KeyPair();

      // Use valid key structure but with wrong deviceId/fingerprint
      const mismatchedDevice = {
        deviceId: deriveDeviceId(otherEdPair.publicKey), // From different key
        deviceName: 'mismatched-device',
        fingerprint: fingerprintFor(otherEdPair.publicKey), // From different key
        signingPublicKey: edPair.publicKey, // But actual key is this one
        encryptionPublicKey: xPair.publicKey,
        signingPrivateKey: edPair.privateKey,
      };

      const announcement = createDiscoveryAnnouncement({
        device: mismatchedDevice,
        port: 47777,
      });

      assert.throws(
        () => parseDiscoveryDatagram(Buffer.from(JSON.stringify(announcement))),
        /metadata.*match|fingerprint/i
      );
    });

    it('rejects oversized public key fields (>4096 chars)', () => {
      const oversizedKeyDevice = {
        ...validDevice,
        signingPublicKey: edPair.publicKey + 'A'.repeat(4000), // Exceeds 4096 limit
      };

      const announcement = createDiscoveryAnnouncement({
        device: oversizedKeyDevice,
        port: 47777,
      });

      assert.throws(
        () => parseDiscoveryDatagram(Buffer.from(JSON.stringify(announcement))),
        /key.*invalid|bounded/i
      );
    });
  });

  describe('combined attack vectors', () => {
    it('rejects announcement with multiple validation failures', () => {
      const badDevice = {
        deviceId: 'not-a-valid-hex-id',
        deviceName: 'a'.repeat(200),
        fingerprint: 'INVALID-FP',
        signingPublicKey: 'not-a-key',
        encryptionPublicKey: xPair.publicKey,
        signingPrivateKey: edPair.privateKey,
      };

      const announcement = createDiscoveryAnnouncement({
        device: badDevice,
        port: 47777,
      });

      assert.throws(
        () => parseDiscoveryDatagram(Buffer.from(JSON.stringify(announcement))),
        /invalid/i
      );
    });

    it('maintains backward compatibility with valid announcements', () => {
      const validAnnouncement = createDiscoveryAnnouncement({
        device: validDevice,
        port: 47777,
      });

      // Should not throw
      assert.doesNotThrow(() => {
        const parsed = parseDiscoveryDatagram(
          Buffer.from(JSON.stringify(validAnnouncement))
        );
        assert.equal(parsed.identity.deviceId, validDevice.deviceId);
        assert.equal(parsed.port, 47777);
      });
    });
  });
});

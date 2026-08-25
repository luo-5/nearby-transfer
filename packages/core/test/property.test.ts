import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Buffer } from 'node:buffer';
import { canonicalJson, parseCanonicalJson, type CanonicalValue } from '../src/canonical-json.js';
import { encodeWireFrame, decodeWireFrame } from '../src/transfer/wire-frame.js';
import { encryptChunk, decryptChunk, KEY_BYTES } from '../src/crypto/session.js';
import { deriveDeviceId, createEd25519KeyPair } from '../src/crypto/identity.js';
import { createTransferManifest, serializeTransferManifest, type ManifestEntry } from '../src/transfer/manifest.js';

describe('Property-Based Invariant Tests (100 trials each)', () => {
  const TRIALS = 100;

  // Invariant 1: canonical-json round-trip & idempotency
  it('Invariant 1: canonical-json round-trip & idempotency', () => {
    for (let i = 0; i < TRIALS; i++) {
      const obj: Record<string, CanonicalValue> = {
        seed: i,
        name: `device_${crypto.randomBytes(4).toString('hex')}`,
        active: i % 2 === 0,
        tags: [`tag_${i}`, `group_${i % 5}`],
        metrics: {
          count: i * 10,
          verified: true,
          nested: { level: 2 },
        },
      };

      const serialized1 = canonicalJson(obj);
      const parsed = parseCanonicalJson(serialized1) as Record<string, unknown>;
      const serialized2 = canonicalJson(parsed as CanonicalValue);

      assert.equal(serialized1, serialized2, `Idempotency failure on trial ${i}`);
      assert.deepEqual(parsed, obj, `Round-trip deepEqual failure on trial ${i}`);
    }
  });

  // Invariant 2: wire-frame round-trip
  it('Invariant 2: wire-frame encode -> decode preserves header and payload', () => {
    for (let i = 0; i < TRIALS; i++) {
      const header = {
        app: 'nearby-transfer',
        protocolVersion: 2,
        type: 'transfer-manifest',
      };
      const payload = crypto.randomBytes(Math.floor(Math.random() * 2048) + 1);

      const encoded = encodeWireFrame({ header, payload });
      const decoded = decodeWireFrame(encoded);

      assert.deepEqual(decoded.header, header);
      assert.ok(decoded.payload.equals(payload));
    }
  });

  // Invariant 3: chunk crypto round-trip
  it('Invariant 3: decrypt(encrypt(p)) === p', () => {
    const key = crypto.randomBytes(KEY_BYTES);
    const taskId = crypto.randomBytes(16).toString('base64url');

    for (let i = 0; i < TRIALS; i++) {
      const plainLength = Math.floor(Math.random() * 4096) + 1;
      const plaintext = crypto.randomBytes(plainLength);
      const path = `docs/file_${i}.txt`;
      const offset = i * 4096;
      const sequence = i;

      const encrypted = encryptChunk({
        key,
        taskId,
        path,
        offset,
        sequence,
        plaintext,
      });

      const decrypted = decryptChunk({
        key,
        nonce: encrypted.nonce,
        taskId,
        path,
        offset,
        sequence,
        plainLength,
        ciphertext: encrypted.ciphertext,
        authTag: encrypted.authTag,
      });

      assert.ok(decrypted.equals(plaintext));
    }
  });

  // Invariant 4: nonce uniqueness
  it('Invariant 4: n consecutive encrypt calls produce n unique nonces', () => {
    const key = crypto.randomBytes(KEY_BYTES);
    const taskId = crypto.randomBytes(16).toString('base64url');
    const seenNonces = new Set<string>();

    for (let i = 0; i < TRIALS; i++) {
      const encrypted = encryptChunk({
        key,
        taskId,
        path: 'test.txt',
        offset: i * 100,
        sequence: i,
        plaintext: Buffer.from('data'),
      });

      const nonceHex = encrypted.nonce.toString('hex');
      assert.equal(seenNonces.has(nonceHex), false, `Duplicate nonce detected on trial ${i}: ${nonceHex}`);
      seenNonces.add(nonceHex);
    }
    assert.equal(seenNonces.size, TRIALS);
  });

  // Invariant 5: deviceId determinism
  it('Invariant 5: identical public key always yields identical deviceId', () => {
    for (let i = 0; i < TRIALS; i++) {
      const keypair = createEd25519KeyPair();
      const id1 = deriveDeviceId(keypair.publicKey);
      const id2 = deriveDeviceId(keypair.publicKey);
      const id3 = deriveDeviceId(keypair.publicKey);

      assert.equal(id1, id2);
      assert.equal(id2, id3);
      assert.match(id1, /^[a-f0-9]{16}$/);
    }
  });

  // Invariant 6: manifest serialization determinism
  it('Invariant 6: identical manifest inputs always produce byte-identical serialized JSON', () => {
    for (let i = 0; i < TRIALS; i++) {
      const taskId = crypto.randomBytes(16).toString('base64url');
      const entries: ManifestEntry[] = [
        { kind: 'directory', path: 'src' },
        { kind: 'file', path: 'src/main.ts', size: 1024, sha256: 'a'.repeat(64) },
        { kind: 'file', path: 'src/util.ts', size: 512, sha256: 'b'.repeat(64) },
      ];

      // Scramble input entry order
      const entriesScrambled = [entries[2]!, entries[0]!, entries[1]!];

      const m1 = createTransferManifest({ taskId, entries });
      const m2 = createTransferManifest({ taskId, entries: entriesScrambled });

      const s1 = serializeTransferManifest(m1);
      const s2 = serializeTransferManifest(m2);

      assert.equal(s1, s2, `Serialization nondeterminism on trial ${i}`);
    }
  });
});

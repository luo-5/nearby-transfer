import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Buffer } from 'node:buffer';
import { encryptChunk, decryptChunk, KEY_BYTES } from '../../src/crypto/session.js';

describe('fuzz-chunk-crypto', () => {
  it('passes 1,000 randomized plaintext encrypt -> decrypt -> compare trials', () => {
    const TRIALS = 1000;
    const key = crypto.randomBytes(KEY_BYTES);
    const taskId = crypto.randomBytes(16).toString('base64url');

    for (let i = 0; i < TRIALS; i++) {
      const plainLen = Math.floor(Math.random() * 8192);
      const plaintext = crypto.randomBytes(plainLen);
      const path = `docs/file_${i % 10}.bin`;
      const offset = i * 8192;
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
        plainLength: plainLen,
        ciphertext: encrypted.ciphertext,
        authTag: encrypted.authTag,
      });

      assert.ok(decrypted.equals(plaintext), `Decryption mismatch on trial ${i}`);
    }
  });
});

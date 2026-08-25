import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import {
  deriveSessionKey,
  encryptChunk,
  decryptChunk,
  KEY_BYTES,
  NONCE_BYTES,
  AUTH_TAG_BYTES,
} from '../src/crypto/session.js';
import { createX25519KeyPair, createEd25519KeyPair, sign, verify } from '../src/crypto/identity.js';

describe('crypto edge tests', () => {
  const aliceX = createX25519KeyPair();
  const bobX = createX25519KeyPair();
  const aliceEd = createEd25519KeyPair();
  const taskId = 'de3U6QplW7_X2w7pwGDibA';
  const manifestSha = 'b'.repeat(64);

  it('rejects identical sender and receiver device IDs during session derivation', () => {
    assert.throws(
      () =>
        deriveSessionKey({
          localPrivateKeyPem: aliceX.privateKey,
          remotePublicKeyPem: bobX.publicKey,
          senderDeviceId: '0123456789abcdef',
          receiverDeviceId: '0123456789abcdef',
          taskId,
          manifestSha256: manifestSha,
        }),
      /different/i,
    );
  });

  it('rejects wrong key types (e.g. Ed25519 key passed to X25519 session derivation)', () => {
    assert.throws(
      () =>
        deriveSessionKey({
          localPrivateKeyPem: aliceEd.privateKey,
          remotePublicKeyPem: bobX.publicKey,
          senderDeviceId: '0123456789abcdef',
          receiverDeviceId: 'fedcba9876543210',
          taskId,
          manifestSha256: manifestSha,
        }),
      /X25519/i,
    );
  });

  it('rejects invalid or tampered ciphertext during chunk decryption', () => {
    const key = Buffer.alloc(KEY_BYTES, 0x42);
    const plaintext = Buffer.from('secret payload');
    const encrypted = encryptChunk({
      key,
      taskId,
      path: 'file.txt',
      offset: 0,
      sequence: 0,
      plaintext,
    });

    // 1. Tampered ciphertext byte
    const tamperedCt = Buffer.from(encrypted.ciphertext);
    tamperedCt[0] ^= 0x01;
    assert.throws(
      () =>
        decryptChunk({
          key,
          nonce: encrypted.nonce,
          taskId,
          path: 'file.txt',
          offset: 0,
          sequence: 0,
          plainLength: plaintext.length,
          ciphertext: tamperedCt,
          authTag: encrypted.authTag,
        }),
      /authentication failed/i,
    );

    // 2. Tampered auth tag
    const tamperedTag = Buffer.from(encrypted.authTag);
    tamperedTag[0] ^= 0xff;
    assert.throws(
      () =>
        decryptChunk({
          key,
          nonce: encrypted.nonce,
          taskId,
          path: 'file.txt',
          offset: 0,
          sequence: 0,
          plainLength: plaintext.length,
          ciphertext: encrypted.ciphertext,
          authTag: tamperedTag,
        }),
      /authentication failed/i,
    );

    // 3. Mismatched AAD parameters (wrong offset / wrong sequence)
    assert.throws(
      () =>
        decryptChunk({
          key,
          nonce: encrypted.nonce,
          taskId,
          path: 'file.txt',
          offset: 100, // modified offset
          sequence: 0,
          plainLength: plaintext.length,
          ciphertext: encrypted.ciphertext,
          authTag: encrypted.authTag,
        }),
      /authentication failed/i,
    );
  });

  it('rejects incorrect key or nonce lengths', () => {
    const validKey = Buffer.alloc(KEY_BYTES);
    const shortKey = Buffer.alloc(16);
    const shortNonce = Buffer.alloc(8);
    const plaintext = Buffer.from('test');

    assert.throws(
      () =>
        encryptChunk({
          key: shortKey,
          taskId,
          path: 'file.txt',
          offset: 0,
          sequence: 0,
          plaintext,
        }),
      /Session key/i,
    );

    assert.throws(
      () =>
        decryptChunk({
          key: validKey,
          nonce: shortNonce,
          taskId,
          path: 'file.txt',
          offset: 0,
          sequence: 0,
          plainLength: 4,
          ciphertext: Buffer.alloc(4),
          authTag: Buffer.alloc(AUTH_TAG_BYTES),
        }),
      /Chunk nonce/i,
    );
  });

  it('returns false on signature verification for tampered messages or wrong keys', () => {
    const message = Buffer.from('hello world');
    const signature = sign(message, aliceEd.privateKey);
    const bobEd = createEd25519KeyPair();

    assert.equal(verify(message, signature, aliceEd.publicKey), true);
    // Verified with wrong public key
    assert.equal(verify(message, signature, bobEd.publicKey), false);
    // Verified with corrupted signature
    const corruptedSig = Buffer.from(signature);
    corruptedSig[0] ^= 0x01;
    assert.equal(verify(message, corruptedSig, aliceEd.publicKey), false);
    // Verified with corrupted message
    const corruptedMsg = Buffer.from('hello world!');
    assert.equal(verify(corruptedMsg, signature, aliceEd.publicKey), false);
  });
});

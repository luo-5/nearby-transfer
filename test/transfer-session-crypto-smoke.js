'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  AUTH_TAG_BYTES,
  CONTEXT,
  KEY_BYTES,
  MAX_CHUNK_BYTES,
  MAX_SEQUENCE,
  NONCE_BYTES,
  buildChunkAad,
  decryptChunk,
  deriveSessionKey,
  encryptChunk
} = require('../src/v2/transfer-session-crypto');

const vector = JSON.parse(fs.readFileSync(
  path.join(__dirname, 'fixtures', 'transfer-session-crypto-v2.json'),
  'utf8'
));
const binding = {
  senderDeviceId: vector.senderDeviceId,
  receiverDeviceId: vector.receiverDeviceId,
  taskId: vector.taskId,
  manifestSha256: vector.manifestSha256
};
const chunkMetadata = {
  taskId: vector.taskId,
  path: vector.chunk.path,
  offset: vector.chunk.offset,
  sequence: vector.chunk.sequence
};

assert.strictEqual(CONTEXT, 'nearby-transfer/v2/file-content');
assert.strictEqual(KEY_BYTES, 32);
assert.strictEqual(NONCE_BYTES, 12);
assert.strictEqual(AUTH_TAG_BYTES, 16);
assert.strictEqual(MAX_SEQUENCE, Number.MAX_SAFE_INTEGER);

const senderKey = deriveSessionKey({
  localPrivateKeyPem: vector.senderPrivateKeyPem,
  remotePublicKeyPem: vector.receiverPublicKeyPem,
  ...binding
});
const receiverKey = deriveSessionKey({
  localPrivateKeyPem: vector.receiverPrivateKeyPem,
  remotePublicKeyPem: vector.senderPublicKeyPem,
  ...binding
});
assert.strictEqual(senderKey.toString('hex'), vector.derivedKeyHex);
assert.deepStrictEqual(receiverKey, senderKey);

const reverseSenderKey = deriveSessionKey({
  localPrivateKeyPem: vector.receiverPrivateKeyPem,
  remotePublicKeyPem: vector.senderPublicKeyPem,
  ...binding,
  senderDeviceId: binding.receiverDeviceId,
  receiverDeviceId: binding.senderDeviceId
});
const reverseReceiverKey = deriveSessionKey({
  localPrivateKeyPem: vector.senderPrivateKeyPem,
  remotePublicKeyPem: vector.receiverPublicKeyPem,
  ...binding,
  senderDeviceId: binding.receiverDeviceId,
  receiverDeviceId: binding.senderDeviceId
});
assert.deepStrictEqual(reverseSenderKey, reverseReceiverKey);
assert.notDeepStrictEqual(reverseSenderKey, senderKey);

const alteredManifestKey = deriveSessionKey({
  localPrivateKeyPem: vector.senderPrivateKeyPem,
  remotePublicKeyPem: vector.receiverPublicKeyPem,
  ...binding,
  manifestSha256: '0'.repeat(64)
});
assert.notDeepStrictEqual(alteredManifestKey, senderKey);

const plaintext = Buffer.from(vector.chunk.plaintextUtf8, 'utf8');
assert.strictEqual(plaintext.length, vector.chunk.plainLength);
const fixtureNonce = Buffer.from(vector.chunk.nonceHex, 'hex');
const fixtureCiphertext = Buffer.from(vector.chunk.ciphertextHex, 'hex');
const fixtureTag = Buffer.from(vector.chunk.authTagHex, 'hex');
const aad = buildChunkAad({
  ...chunkMetadata,
  plainLength: plaintext.length
});
assert.strictEqual(aad.toString('hex'), vector.chunk.aadHex);

// Both implementations decrypt this fixed Node/Java interoperability vector.
assert.deepStrictEqual(decryptChunk({
  key: receiverKey,
  nonce: fixtureNonce,
  ...chunkMetadata,
  plainLength: plaintext.length,
  ciphertext: fixtureCiphertext,
  authTag: fixtureTag
}), plaintext);

// Deterministic randomness is injected only inside this synchronous vector
// assertion. Production callers cannot supply or reuse a nonce.
const originalRandomBytes = crypto.randomBytes;
try {
  crypto.randomBytes = (size) => {
    assert.strictEqual(size, NONCE_BYTES);
    return Buffer.from(fixtureNonce);
  };
  const vectorSealed = encryptChunk({
    key: senderKey,
    ...chunkMetadata,
    plaintext
  });
  assert.deepStrictEqual(vectorSealed.nonce, fixtureNonce);
  assert.deepStrictEqual(vectorSealed.ciphertext, fixtureCiphertext);
  assert.deepStrictEqual(vectorSealed.authTag, fixtureTag);
} finally {
  crypto.randomBytes = originalRandomBytes;
}

const sealed = encryptChunk({
  key: senderKey,
  ...chunkMetadata,
  plaintext
});
const sealedAgain = encryptChunk({
  key: senderKey,
  ...chunkMetadata,
  plaintext
});
assert.strictEqual(sealed.nonce.length, NONCE_BYTES);
assert.strictEqual(sealed.authTag.length, AUTH_TAG_BYTES);
assert.notDeepStrictEqual(sealedAgain.nonce, sealed.nonce, 'fresh encryptions must not reuse a nonce');
assert.deepStrictEqual(decryptChunk({
  key: receiverKey,
  nonce: sealed.nonce,
  ...chunkMetadata,
  plainLength: plaintext.length,
  ciphertext: sealed.ciphertext,
  authTag: sealed.authTag
}), plaintext);

function expectAuthenticationFailure(overrides) {
  let returnedPlaintext = null;
  assert.throws(() => {
    returnedPlaintext = decryptChunk({
      key: receiverKey,
      nonce: fixtureNonce,
      ...chunkMetadata,
      plainLength: plaintext.length,
      ciphertext: fixtureCiphertext,
      authTag: fixtureTag,
      ...overrides
    });
  }, /authentication failed/);
  assert.strictEqual(returnedPlaintext, null, 'authentication failure must not return plaintext');
}

const alteredCiphertext = Buffer.from(fixtureCiphertext);
alteredCiphertext[0] ^= 0x80;
const alteredTag = Buffer.from(fixtureTag);
alteredTag[0] ^= 0x80;
const alteredNonce = Buffer.from(fixtureNonce);
alteredNonce[0] ^= 0x80;
const alteredKey = Buffer.from(receiverKey);
alteredKey[0] ^= 0x80;
expectAuthenticationFailure({ ciphertext: alteredCiphertext });
expectAuthenticationFailure({ authTag: alteredTag });
expectAuthenticationFailure({ nonce: alteredNonce });
expectAuthenticationFailure({ key: alteredKey });
expectAuthenticationFailure({ path: 'docs/other.txt' });
expectAuthenticationFailure({ offset: chunkMetadata.offset + 1 });
expectAuthenticationFailure({ sequence: chunkMetadata.sequence + 1 });
expectAuthenticationFailure({ taskId: 'AgMEBQYHCAkKCwwNDg8QEQ' });

const ed25519 = crypto.generateKeyPairSync('ed25519');
assert.throws(() => deriveSessionKey({
  localPrivateKeyPem: ed25519.privateKey.export({ type: 'pkcs8', format: 'pem' }),
  remotePublicKeyPem: vector.receiverPublicKeyPem,
  ...binding
}), /X25519/);
assert.throws(() => deriveSessionKey({
  localPrivateKeyPem: vector.senderPrivateKeyPem,
  remotePublicKeyPem: ed25519.publicKey.export({ type: 'spki', format: 'pem' }),
  ...binding
}), /X25519/);
assert.throws(() => deriveSessionKey({
  localPrivateKeyPem: vector.senderPublicKeyPem,
  remotePublicKeyPem: vector.receiverPublicKeyPem,
  ...binding
}), /PRIVATE KEY/);
assert.throws(() => deriveSessionKey({
  localPrivateKeyPem: vector.senderPrivateKeyPem,
  remotePublicKeyPem: vector.receiverPrivateKeyPem,
  ...binding
}), /PUBLIC KEY/);
const zeroPublicDer = Buffer.concat([
  Buffer.from('302a300506032b656e032100', 'hex'),
  Buffer.alloc(32)
]);
const zeroPublicPem = `-----BEGIN PUBLIC KEY-----\n${zeroPublicDer.toString('base64')}\n-----END PUBLIC KEY-----\n`;
assert.throws(() => deriveSessionKey({
  localPrivateKeyPem: vector.senderPrivateKeyPem,
  remotePublicKeyPem: zeroPublicPem,
  ...binding
}), /shared secret|derive/i);
assert.deepStrictEqual(deriveSessionKey({
  localPrivateKeyPem: vector.senderPrivateKeyPem.replace(/\n/g, '\r\n'),
  remotePublicKeyPem: vector.receiverPublicKeyPem.replace(/\n/g, '\r\n'),
  ...binding
}), senderKey);
assert.throws(() => deriveSessionKey({
  localPrivateKeyPem: vector.senderPrivateKeyPem,
  remotePublicKeyPem: vector.receiverPublicKeyPem,
  ...binding,
  senderDeviceId: 'ABCDEF0123456789'
}), /device ID/);
assert.throws(() => deriveSessionKey({
  localPrivateKeyPem: vector.senderPrivateKeyPem,
  remotePublicKeyPem: vector.receiverPublicKeyPem,
  ...binding,
  manifestSha256: vector.manifestSha256.toUpperCase()
}), /SHA-256/);
assert.throws(() => deriveSessionKey({
  localPrivateKeyPem: vector.senderPrivateKeyPem,
  remotePublicKeyPem: vector.receiverPublicKeyPem,
  ...binding,
  receiverDeviceId: binding.senderDeviceId
}), /different/);

assert.throws(() => encryptChunk({ key: Buffer.alloc(31), ...chunkMetadata, plaintext }), /32 bytes/);
assert.throws(() => encryptChunk({ key: senderKey, ...chunkMetadata, offset: -1, plaintext }), /safe integer/);
assert.throws(() => encryptChunk({ key: senderKey, ...chunkMetadata, offset: 1.5, plaintext }), /safe integer/);
assert.throws(() => encryptChunk({ key: senderKey, ...chunkMetadata, offset: Number.MAX_SAFE_INTEGER + 1, plaintext }), /safe integer/);
assert.throws(() => encryptChunk({ key: senderKey, ...chunkMetadata, offset: Number.MAX_SAFE_INTEGER, plaintext }), /byte range/);
assert.throws(() => encryptChunk({ key: senderKey, ...chunkMetadata, sequence: MAX_SEQUENCE + 1, plaintext }), /safe integer/);
assert.doesNotThrow(() => buildChunkAad({
  ...chunkMetadata,
  offset: Number.MAX_SAFE_INTEGER,
  sequence: MAX_SEQUENCE,
  plainLength: 0
}));
assert.throws(() => encryptChunk({ key: senderKey, ...chunkMetadata, path: '../escape.txt', plaintext }), /path/i);
assert.throws(() => encryptChunk({ key: senderKey, ...chunkMetadata, plaintext: Buffer.alloc(MAX_CHUNK_BYTES + 1) }), /maximum chunk size/);
assert.throws(() => decryptChunk({
  key: receiverKey,
  nonce: fixtureNonce,
  ...chunkMetadata,
  plainLength: plaintext.length - 1,
  ciphertext: fixtureCiphertext,
  authTag: fixtureTag
}), /ciphertext length/);
assert.throws(() => decryptChunk({
  key: receiverKey,
  nonce: fixtureNonce,
  ...chunkMetadata,
  plainLength: plaintext.length,
  ciphertext: fixtureCiphertext,
  authTag: Buffer.alloc(15)
}), /16 bytes/);
assert.throws(() => encryptChunk({
  key: senderKey,
  nonce: fixtureNonce,
  ...chunkMetadata,
  plaintext
}), /missing or unknown fields/);
assert.throws(() => encryptChunk({
  key: senderKey,
  ...chunkMetadata,
  plaintext,
  ignored: true
}), /missing or unknown fields/);

console.log('transfer session crypto smoke test passed');

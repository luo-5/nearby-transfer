const assert = require('assert');
const crypto = require('crypto');
const { Readable, Writable } = require('stream');
const { pipeline } = require('stream/promises');
const {
  createX25519KeyPair,
  deriveTransferKey,
  EncryptFrameStream,
  DecryptFrameStream
} = require('../src/core/crypto');

async function main() {
  const alice = createX25519KeyPair();
  const bob = createX25519KeyPair();
  const transferId = 'crypto-smoke-test';
  const aliceKey = deriveTransferKey(alice.privateKey, bob.publicKey, transferId);
  const bobKey = deriveTransferKey(bob.privateKey, alice.publicKey, transferId);
  assert.deepStrictEqual(aliceKey, bobKey);

  await assertRoundTripWithSplitFrames(aliceKey, bobKey);
  await assertEmptyInput(aliceKey, bobKey);
  await assertTamperedCiphertextFails(aliceKey, bobKey);
  await assertWrongKeyFails(aliceKey);
  await assertTruncatedFrameFails(aliceKey, bobKey);
  await assertOversizedFrameFails(bobKey);
}

async function assertRoundTripWithSplitFrames(encryptionKey, decryptionKey) {
  const sourceChunks = [
    Buffer.from('hello encrypted local network'.repeat(2048)),
    crypto.randomBytes(72 * 1024),
    Buffer.from('final frame')
  ];
  const encrypted = await encrypt(sourceChunks, encryptionKey);
  const splitEncrypted = splitBuffer(encrypted, [1, 2, 3, 5, 8, 13, 21, 34, 55, 89]);
  const decrypted = await decrypt(splitEncrypted, decryptionKey);
  assert.deepStrictEqual(decrypted, Buffer.concat(sourceChunks));
}

async function assertEmptyInput(encryptionKey, decryptionKey) {
  const encrypted = await encrypt([], encryptionKey);
  assert.strictEqual(encrypted.length, 0);
  assert.deepStrictEqual(await decrypt([], decryptionKey), Buffer.alloc(0));
}

async function assertTamperedCiphertextFails(encryptionKey, decryptionKey) {
  const encrypted = await encrypt([Buffer.from('authenticated payload')], encryptionKey);
  encrypted[encrypted.length - 1] ^= 0x01;
  await assert.rejects(() => decrypt([encrypted], decryptionKey));
}

async function assertWrongKeyFails(encryptionKey) {
  const encrypted = await encrypt([Buffer.from('secret payload')], encryptionKey);
  await assert.rejects(() => decrypt([encrypted], crypto.randomBytes(32)));
}

async function assertTruncatedFrameFails(encryptionKey, decryptionKey) {
  const encrypted = await encrypt([Buffer.from('complete frame')], encryptionKey);
  const truncated = encrypted.subarray(0, encrypted.length - 1);
  await assert.rejects(
    () => decrypt([truncated], decryptionKey),
    /Encrypted stream ended with an incomplete frame/
  );
}

async function assertOversizedFrameFails(decryptionKey) {
  const header = Buffer.alloc(32);
  header.writeUInt32BE((16 * 1024 * 1024) + 1, 0);
  await assert.rejects(
    () => decrypt([header], decryptionKey),
    /Encrypted frame is too large/
  );
}

async function encrypt(chunks, key) {
  return collectPipeline(Readable.from(chunks), new EncryptFrameStream(key));
}

async function decrypt(chunks, key) {
  return collectPipeline(Readable.from(chunks), new DecryptFrameStream(key));
}

async function collectPipeline(source, transform) {
  const output = [];
  const collector = new Writable({
    write(chunk, _encoding, callback) {
      output.push(chunk);
      callback();
    }
  });
  await pipeline(source, transform, collector);
  return Buffer.concat(output);
}

function splitBuffer(buffer, sizes) {
  const chunks = [];
  let offset = 0;
  let index = 0;
  while (offset < buffer.length) {
    const end = Math.min(buffer.length, offset + sizes[index % sizes.length]);
    chunks.push(buffer.subarray(offset, end));
    offset = end;
    index += 1;
  }
  return chunks;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

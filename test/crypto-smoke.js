const assert = require('assert');
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

  const source = Buffer.from('hello encrypted local network'.repeat(4096));
  const chunks = [];
  const collector = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(chunk);
      callback();
    }
  });

  await pipeline(
    Readable.from([source]),
    new EncryptFrameStream(aliceKey),
    new DecryptFrameStream(bobKey),
    collector
  );

  assert.deepStrictEqual(Buffer.concat(chunks), source);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

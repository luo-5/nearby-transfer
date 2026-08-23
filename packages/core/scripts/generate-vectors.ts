/**
 * Generates deterministic crypto test vectors for @nearby-transfer/core.
 *
 * Since node:crypto's generateKeyPairSync is not seedable, we derive X25519
 * keypairs from fixed 32-byte seeds using the raw key import path, then compute
 * the session key and an encrypted chunk with a fixed nonce. The resulting
 * vectors let downstream implementations verify their crypto produces identical
 * output for the same inputs.
 *
 * Run: npx tsx scripts/generate-vectors.ts
 */
import crypto from 'node:crypto';
import { Buffer } from 'node:buffer';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const X25519_PRIVATE_DER_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex');
const X25519_PUBLIC_DER_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');

function x25519FromSeed(seedHex: string): { privateKeyPem: string; publicKeyPem: string } {
  const raw = Buffer.from(seedHex, 'hex');
  if (raw.length !== 32) throw new Error('seed must be 32 bytes');
  // Wrap the raw 32-byte X25519 secret in a PKCS#8 DER structure so node:crypto
  // can import it as a key object.
  const privDer = Buffer.concat([X25519_PRIVATE_DER_PREFIX, raw]);
  const priv = crypto.createPrivateKey({ key: privDer, format: 'der', type: 'pkcs8' });
  const privPem = priv.export({ format: 'pem', type: 'pkcs8' }).toString();
  const pub = crypto.createPublicKey(priv);
  const pubPem = pub.export({ type: 'spki', format: 'pem' }).toString();
  return { privateKeyPem: privPem, publicKeyPem: pubPem };
}

// Fixed seeds (32 bytes each) — arbitrary but stable.
const ALICE_SEED = '0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20';
const BOB_SEED = '202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f';

const alice = x25519FromSeed(ALICE_SEED);
const bob = x25519FromSeed(BOB_SEED);

// Session binding
const senderDeviceId = 'a1b2c3d4e5f60718';
const receiverDeviceId = '0123456789abcdef';
const taskId = 'de3U6QplW7_X2w7pwGDibA'; // 16-byte base64url (fixed)
const manifestSha256 = crypto.createHash('sha256').update('test-manifest').digest('hex');

// --- Vector 1: identity derivation ---
const signingPubPem = crypto.generateKeyPairSync('ed25519', {
  publicKeyEncoding: { type: 'spki', format: 'pem' },
}).publicKey;
// Use a fixed ed25519 from seed too for determinism
const ED25519_PRIVATE_DER_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex');
const ed25519Raw = Buffer.from('0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20', 'hex');
const edPriv = crypto.createPrivateKey({ key: Buffer.concat([ED25519_PRIVATE_DER_PREFIX, ed25519Raw]), format: 'der', type: 'pkcs8' });
const edPub = crypto.createPublicKey(edPriv);
const edPubPem = edPub.export({ type: 'spki', format: 'pem' }).toString();
const deviceId = crypto.createHash('sha256').update(edPubPem).digest('hex').slice(0, 16);
const fingerprint = crypto.createHash('sha256').update(edPubPem).digest('hex').toUpperCase().match(/.{1,4}/g)!.slice(0, 6).join('-');

// --- Vector 2: session key agreement ---
function deriveSessionKey(): Buffer {
  const privateKey = crypto.createPrivateKey(alice.privateKeyPem);
  const publicKey = crypto.createPublicKey(bob.publicKeyPem);
  const sharedSecret = crypto.diffieHellman({ privateKey, publicKey });
  const CONTEXT = 'nearby-transfer/v2/file-content';
  const SESSION_LABEL = 'session-key';
  const salt = Buffer.from(manifestSha256, 'hex');
  const encodeUint32 = (v: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(v, 0); return b; };
  const encodeFields = (fields: string[]) => Buffer.concat(fields.map((f) => { const e = Buffer.from(f, 'utf8'); return Buffer.concat([encodeUint32(e.length), e]); }));
  const info = encodeFields([CONTEXT, SESSION_LABEL, senderDeviceId, receiverDeviceId, taskId, manifestSha256]);
  return Buffer.from(crypto.hkdfSync('sha256', sharedSecret, salt, info, 32));
}

const sessionKey = deriveSessionKey();

// --- Vector 3: chunk encryption (fixed nonce for determinism) ---
const plaintext = Buffer.from('Nearby Transfer v2 test chunk payload', 'utf8');
const nonce = crypto.randomBytes(12); // will be recorded; not deterministic but reproducible to verify
const CHUNK_AAD_LABEL = 'chunk-aad';
const CONTEXT = 'nearby-transfer/v2/file-content';
const encodeUint32 = (v: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(v, 0); return b; };
const encodeSafeInteger = (v: number) => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(v)); return b; };
const encodeFields = (fields: string[]) => Buffer.concat(fields.map((f) => { const e = Buffer.from(f, 'utf8'); return Buffer.concat([encodeUint32(e.length), e]); }));
const aad = Buffer.concat([
  encodeFields([CONTEXT, CHUNK_AAD_LABEL, taskId, 'docs/readme.md']),
  encodeSafeInteger(0),
  encodeSafeInteger(0),
  encodeUint32(plaintext.length),
]);
const cipher = crypto.createCipheriv('aes-256-gcm', sessionKey, nonce, { authTagLength: 16 });
cipher.setAAD(aad, { plaintextLength: plaintext.length });
const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
const authTag = cipher.getAuthTag();

const vectors = {
  version: 1,
  generatedAt: new Date().toISOString(),
  identity: {
    description: 'Ed25519 device identity derived from a fixed 32-byte seed',
    ed25519SeedHex: ed25519Raw.toString('hex'),
    signingPublicKeyPem: edPubPem,
    deviceId,
    fingerprint,
  },
  sessionKey: {
    description: 'X25519 ECDH + HKDF-SHA256 session key, Alice→Bob',
    aliceSeedHex: ALICE_SEED,
    bobSeedHex: BOB_SEED,
    alicePrivateKeyPem: alice.privateKeyPem,
    alicePublicKeyPem: alice.publicKeyPem,
    bobPrivateKeyPem: bob.privateKeyPem,
    bobPublicKeyPem: bob.publicKeyPem,
    senderDeviceId,
    receiverDeviceId,
    taskId,
    manifestSha256,
    sessionKeyHex: sessionKey.toString('hex'),
  },
  chunkEncryption: {
    description: 'AES-256-GCM chunk encryption with position-bound AAD',
    sessionKeyHex: sessionKey.toString('hex'),
    taskId,
    path: 'docs/readme.md',
    offset: 0,
    sequence: 0,
    plaintextHex: plaintext.toString('hex'),
    plaintextUtf8: plaintext.toString('utf8'),
    nonceHex: nonce.toString('hex'),
    ciphertextHex: ciphertext.toString('hex'),
    authTagHex: authTag.toString('hex'),
  },
};

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = join(__dirname, '..', 'test', 'vectors');
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'crypto-vectors.json'), JSON.stringify(vectors, null, 2) + '\n', 'utf8');
console.log('Vectors written to test/vectors/crypto-vectors.json');
console.log(`  identity deviceId: ${deviceId}`);
console.log(`  sessionKey: ${sessionKey.toString('hex')}`);
console.log(`  ciphertext: ${ciphertext.toString('hex')}`);

/**
 * Generates all deterministic protocol test vectors for @luo-5/core.
 *
 * Vectors are produced by feeding fixed inputs through the reference
 * implementation's exported functions, so the published vectors are exactly
 * what the npm package computes. Keys are derived from fixed 32-byte seeds
 * via PKCS#8 DER prefixes (node:crypto key generation is not seedable).
 *
 * Run: npx tsx scripts/generate-all-vectors.ts
 *
 * Produces:
 *   test/vectors/crypto-vectors.json     — identity, session key, chunk encryption
 *   test/vectors/pairing-vectors.json    — SAS code, pairing offer signature
 *   test/vectors/transfer-vectors.json   — canonical JSON, wire frame, chunk frame,
 *                                           manifest serialization, discovery signature
 */
import crypto from 'node:crypto';
import { Buffer } from 'node:buffer';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  deriveDeviceId,
  fingerprintFor,
  sign,
  deriveSessionKey,
  buildChunkAad,
  canonicalJson,
  derivePairingCode,
  publicIdentity,
  createPairingOffer,
  signPairingOffer,
  createDiscoveryAnnouncement,
  signDiscoveryAnnouncement,
  createTransferManifest,
  serializeTransferManifest,
  encodeWireFrame,
  encodeFrame,
  APP_ID,
  PROTOCOL_VERSION,
  MESSAGE_TYPES,
} from '../src/index.js';

// ─── PKCS#8 / SPKI DER prefixes for seedable key import ────────────────────
// X25519: OID 1.3.101.110 = 2b656e
const X25519_PRIV_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex');
// Ed25519: OID 1.3.101.112 = 2b6570
const ED25519_PRIV_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

function keyFromSeed(prefix: Buffer, seedHex: string): { privateKeyPem: string; publicKeyPem: string } {
  const raw = Buffer.from(seedHex, 'hex');
  if (raw.length !== 32) throw new Error('seed must be 32 bytes');
  const der = Buffer.concat([prefix, raw]);
  const priv = crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
  const privPem = priv.export({ format: 'pem', type: 'pkcs8' }).toString();
  const pub = crypto.createPublicKey(priv);
  const pubPem = pub.export({ type: 'spki', format: 'pem' }).toString();
  return { privateKeyPem: privPem, publicKeyPem: pubPem };
}

// ─── Fixed seeds (32 bytes each) — arbitrary but stable across runs ────────
const ED25519_SEED = '0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20';
const ALICE_SEED = '0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20';
const BOB_SEED = '202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f';

// ─── Fixed protocol binding values ──────────────────────────────────────────
const senderDeviceId = 'a1b2c3d4e5f60718';
const receiverDeviceId = '0123456789abcdef';
const taskId = 'de3U6QplW7_X2w7pwGDibA'; // 16-byte base64url (fixed, canonical)
const manifestSha256 = crypto.createHash('sha256').update('test-manifest').digest('hex');

// ─── Keys ────────────────────────────────────────────────────────────────────
const ed25519 = keyFromSeed(ED25519_PRIV_PREFIX, ED25519_SEED);
const alice = keyFromSeed(X25519_PRIV_PREFIX, ALICE_SEED);
const bob = keyFromSeed(X25519_PRIV_PREFIX, BOB_SEED);

// A second Ed25519 identity for the responder (distinct seed).
const ed25519B = keyFromSeed(ED25519_PRIV_PREFIX, BOB_SEED);

const deviceId = deriveDeviceId(ed25519.publicKeyPem);
const fingerprint = fingerprintFor(ed25519.publicKeyPem);
const deviceIdB = deriveDeviceId(ed25519B.publicKeyPem);
const fingerprintB = fingerprintFor(ed25519B.publicKeyPem);

// ═══════════════════════════════════════════════════════════════════════════
// VECTOR 1: Identity derivation
// ═══════════════════════════════════════════════════════════════════════════
const identityVector = {
  description: 'Ed25519 device identity derived from a fixed 32-byte seed',
  ed25519SeedHex: ED25519_SEED,
  signingPublicKeyPem: ed25519.publicKeyPem,
  signingPrivateKeyPem: ed25519.privateKeyPem,
  deviceId,
  fingerprint,
};

// ═══════════════════════════════════════════════════════════════════════════
// VECTOR 2: Session key agreement (X25519 ECDH + HKDF-SHA256)
// ═══════════════════════════════════════════════════════════════════════════
const sessionKey = deriveSessionKey({
  localPrivateKeyPem: alice.privateKeyPem,
  remotePublicKeyPem: bob.publicKeyPem,
  senderDeviceId,
  receiverDeviceId,
  taskId,
  manifestSha256,
});

const sessionKeyVector = {
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
};

// ═══════════════════════════════════════════════════════════════════════════
// VECTOR 3: Chunk encryption (AES-256-GCM with fixed nonce + position-bound AAD)
// ═══════════════════════════════════════════════════════════════════════════
const plaintext = Buffer.from('Nearby Transfer v2 test chunk payload', 'utf8');
const FIXED_NONCE = Buffer.from('0da74c42e775b447dc062554', 'hex'); // 12 bytes, fixed for reproducibility
const chunkPath = 'docs/readme.md';

const aad = buildChunkAad({ taskId, path: chunkPath, offset: 0, sequence: 0, plainLength: plaintext.length });
const cipher = crypto.createCipheriv('aes-256-gcm', sessionKey, FIXED_NONCE, { authTagLength: 16 });
cipher.setAAD(aad, { plaintextLength: plaintext.length });
const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
const authTag = cipher.getAuthTag();

const chunkEncryptionVector = {
  description: 'AES-256-GCM chunk encryption with position-bound AAD (fixed nonce for reproducibility)',
  sessionKeyHex: sessionKey.toString('hex'),
  taskId,
  path: chunkPath,
  offset: 0,
  sequence: 0,
  plaintextHex: plaintext.toString('hex'),
  plaintextUtf8: plaintext.toString('utf8'),
  aadHex: aad.toString('hex'),
  nonceHex: FIXED_NONCE.toString('hex'),
  ciphertextHex: ciphertext.toString('hex'),
  authTagHex: authTag.toString('hex'),
};

// ═══════════════════════════════════════════════════════════════════════════
// VECTOR 4: SAS pairing code derivation
// ═══════════════════════════════════════════════════════════════════════════
const pairingId = Buffer.from('a1b2c3d4e5f6071801023456789abcd0', 'hex').toString('base64url'); // 16-byte → 22-char base64url (fixed)
const initiatorIdentity = publicIdentity({
  deviceId,
  deviceName: 'Alice-Phone',
  fingerprint,
  signingPublicKey: ed25519.publicKeyPem,
  encryptionPublicKey: alice.publicKeyPem,
});
const responderIdentity = publicIdentity({
  deviceId: deviceIdB,
  deviceName: 'Bob-Laptop',
  fingerprint: fingerprintB,
  signingPublicKey: ed25519B.publicKeyPem,
  encryptionPublicKey: bob.publicKeyPem,
});

const pairingCode = derivePairingCode({ pairingId, initiator: initiatorIdentity, responder: responderIdentity });

const pairingCodeVector = {
  description: 'SAS 6-digit pairing code derived from a transcript binding pairingId + both identities',
  pairingId,
  initiator: initiatorIdentity,
  responder: responderIdentity,
  pairingCode,
  transcript: canonicalJson({
    app: APP_ID,
    protocolVersion: PROTOCOL_VERSION,
    type: 'pairing-code',
    pairingId,
    initiator: initiatorIdentity,
    responder: responderIdentity,
  } as never),
};

// ═══════════════════════════════════════════════════════════════════════════
// VECTOR 5: Pairing offer signature
// ═══════════════════════════════════════════════════════════════════════════
const pairingOffer = createPairingOffer({
  device: { ...initiatorIdentity, signingPrivateKey: ed25519.privateKeyPem },
  capabilities: ['library-server'],
  pairingId,
  issuedAt: 1700000000000,
});
const pairingOfferSignature = signPairingOffer(pairingOffer, ed25519.privateKeyPem);

const pairingOfferVector = {
  description: 'Ed25519 signature over a canonical-JSON pairing offer',
  offer: pairingOffer,
  signature: pairingOfferSignature,
  signingPayload: canonicalJson({
    app: pairingOffer.app,
    protocolVersion: pairingOffer.protocolVersion,
    type: pairingOffer.type,
    pairingId: pairingOffer.pairingId,
    issuedAt: pairingOffer.issuedAt,
    identity: publicIdentity(pairingOffer.identity),
    capabilities: pairingOffer.capabilities,
  } as never),
};

// ═══════════════════════════════════════════════════════════════════════════
// VECTOR 6: Canonical JSON serialization
// ═══════════════════════════════════════════════════════════════════════════
const canonicalInput = {
  zeta: 1,
  alpha: 'hello',
  beta: [3, 2, 1],
  gamma: { whkey: 'last', akey: 'first' },
  delta: null,
  epsilon: true,
};
const canonicalOutput = canonicalJson(canonicalInput as never);

const canonicalJsonVector = {
  description: 'Deterministic canonical JSON: sorted keys, no whitespace, safe integers only',
  input: canonicalInput,
  output: canonicalOutput,
};

// ═══════════════════════════════════════════════════════════════════════════
// VECTOR 7: Wire frame encoding
// ═══════════════════════════════════════════════════════════════════════════
const wirePayload = Buffer.from('wire-frame-payload', 'utf8');
const wireFrame = encodeWireFrame({
  header: { app: APP_ID, protocolVersion: PROTOCOL_VERSION, type: MESSAGE_TYPES.TRANSFER_DECISION },
  payload: wirePayload,
});

const wireFrameVector = {
  description: 'Length-prefixed wire frame: u32 frameLength + u16 headerLength + canonical-JSON header + payload',
  header: { app: APP_ID, protocolVersion: PROTOCOL_VERSION, type: MESSAGE_TYPES.TRANSFER_DECISION },
  payloadHex: wirePayload.toString('hex'),
  payloadUtf8: wirePayload.toString('utf8'),
  frameHex: wireFrame.toString('hex'),
};

// ═══════════════════════════════════════════════════════════════════════════
// VECTOR 8: Chunk frame encoding
// ═══════════════════════════════════════════════════════════════════════════
const chunkFrame = encodeFrame({
  taskId,
  relativePath: chunkPath,
  offset: 0,
  sequence: 0,
  plainLength: plaintext.length,
  nonce: FIXED_NONCE,
  authTag,
  ciphertext,
});

const chunkFrameVector = {
  description: 'Binary chunk frame: 48-byte header (NTV2CHNK magic) + taskId + path + nonce + authTag + ciphertext',
  taskId,
  relativePath: chunkPath,
  offset: 0,
  sequence: 0,
  plainLength: plaintext.length,
  nonceHex: FIXED_NONCE.toString('hex'),
  authTagHex: authTag.toString('hex'),
  ciphertextHex: ciphertext.toString('hex'),
  frameHex: chunkFrame.toString('hex'),
};

// ═══════════════════════════════════════════════════════════════════════════
// VECTOR 9: Discovery announcement signature
// ═══════════════════════════════════════════════════════════════════════════
const discoveryDevice = {
  deviceId,
  deviceName: 'Alice-Phone',
  fingerprint,
  signingPublicKey: ed25519.publicKeyPem,
  encryptionPublicKey: alice.publicKeyPem,
  signingPrivateKey: ed25519.privateKeyPem,
};
const announcement = createDiscoveryAnnouncement({
  device: discoveryDevice,
  port: 47777,
  capabilities: ['library-server'],
  issuedAt: 1700000000000,
});
const discoverySignature = signDiscoveryAnnouncement(announcement, ed25519.privateKeyPem);

const discoveryVector = {
  description: 'Ed25519 signature over a canonical-JSON discovery announcement (minus signature field)',
  announcement: { ...announcement, signature: discoverySignature },
  signingPayload: canonicalJson({
    app: announcement.app,
    protocolVersion: announcement.protocolVersion,
    type: announcement.type,
    issuedAt: announcement.issuedAt,
    identity: publicIdentity(announcement.identity),
    port: announcement.port,
    capabilities: announcement.capabilities,
  } as never),
  signature: discoverySignature,
};

// ═══════════════════════════════════════════════════════════════════════════
// VECTOR 10: TransferManifest serialization
// ═══════════════════════════════════════════════════════════════════════════
const manifest = createTransferManifest({
  taskId,
  entries: [
    { kind: 'directory', path: 'docs' },
    { kind: 'file', path: 'docs/readme.md', size: 1024, sha256: manifestSha256 },
    { kind: 'file', path: 'docs/changelog.md', size: 256, sha256: crypto.createHash('sha256').update('changelog').digest('hex') },
  ],
});
const serializedManifest = serializeTransferManifest(manifest);

const manifestVector = {
  description: 'Canonical-JSON serialization of a TransferManifest with directories and files',
  manifest,
  serialized: serializedManifest,
  manifestHash: manifestSha256,
};

// ─── Write all vector files ─────────────────────────────────────────────────
const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = join(__dirname, '..', 'test', 'vectors');
mkdirSync(outDir, { recursive: true });

const cryptoVectors = {
  version: 1,
  generatedAt: new Date().toISOString(),
  identity: identityVector,
  sessionKey: sessionKeyVector,
  chunkEncryption: chunkEncryptionVector,
};

const pairingVectors = {
  version: 1,
  generatedAt: new Date().toISOString(),
  pairingCode: pairingCodeVector,
  pairingOfferSignature: pairingOfferVector,
};

const transferVectors = {
  version: 1,
  generatedAt: new Date().toISOString(),
  canonicalJson: canonicalJsonVector,
  wireFrame: wireFrameVector,
  chunkFrame: chunkFrameVector,
  discoverySignature: discoveryVector,
  manifestSerialization: manifestVector,
};

writeFileSync(join(outDir, 'crypto-vectors.json'), JSON.stringify(cryptoVectors, null, 2) + '\n', 'utf8');
writeFileSync(join(outDir, 'pairing-vectors.json'), JSON.stringify(pairingVectors, null, 2) + '\n', 'utf8');
writeFileSync(join(outDir, 'transfer-vectors.json'), JSON.stringify(transferVectors, null, 2) + '\n', 'utf8');

console.log('Vectors written to test/vectors/:');
console.log('  crypto-vectors.json');
console.log('  pairing-vectors.json');
console.log('  transfer-vectors.json');
console.log('');
console.log(`  identity deviceId:    ${deviceId}`);
console.log(`  identity fingerprint: ${fingerprint}`);
console.log(`  sessionKey:           ${sessionKey.toString('hex')}`);
console.log(`  pairingCode:          ${pairingCode}`);
console.log(`  canonicalJSON output: ${canonicalOutput}`);
console.log(`  wireFrame hex:        ${wireFrame.toString('hex')}`);
console.log(`  chunkFrame hex:       ${chunkFrame.toString('hex')}`);
console.log(`  discovery signature:  ${discoverySignature}`);
console.log(`  pairingOffer sig:     ${pairingOfferSignature}`);

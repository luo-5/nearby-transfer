/**
 * Verifies all deterministic test vectors against the @luo-5/core reference
 * implementation. Each vector was produced by feeding fixed inputs through the
 * core's exported functions (see scripts/generate-all-vectors.ts); this test
 * ensures the published package reproduces them exactly.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Buffer } from 'node:buffer';

import {
  deriveDeviceId,
  fingerprintFor,
  deriveSessionKey,
  decryptChunk,
  buildChunkAad,
  canonicalJson,
  derivePairingCode,
  publicIdentity,
  verifyPairingOffer,
  verifyDiscoveryAnnouncement,
  serializeTransferManifest,
  decodeWireFrame,
  decodeFrame,
  type CanonicalValue,
} from '../src/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (name: string) => JSON.parse(readFileSync(join(__dirname, 'vectors', name), 'utf8'));

const cryptoVectors = read('crypto-vectors.json');
const pairingVectors = read('pairing-vectors.json');
const transferVectors = read('transfer-vectors.json');

// ─── Vector 1: Identity ─────────────────────────────────────────────────────
test('vector: identity derivation matches reference', () => {
  const v = cryptoVectors.identity;
  assert.equal(deriveDeviceId(v.signingPublicKeyPem), v.deviceId);
  assert.equal(fingerprintFor(v.signingPublicKeyPem), v.fingerprint);
  assert.match(v.deviceId, /^[a-f0-9]{16}$/);
  assert.match(v.fingerprint, /^[0-9A-F]{4}(?:-[0-9A-F]{4}){5}$/);
});

// ─── Vector 2: Session key ───────────────────────────────────────────────────
test('vector: session key agreement matches reference', () => {
  const v = cryptoVectors.sessionKey;
  const key = deriveSessionKey({
    localPrivateKeyPem: v.alicePrivateKeyPem,
    remotePublicKeyPem: v.bobPublicKeyPem,
    senderDeviceId: v.senderDeviceId,
    receiverDeviceId: v.receiverDeviceId,
    taskId: v.taskId,
    manifestSha256: v.manifestSha256,
  });
  assert.equal(key.toString('hex'), v.sessionKeyHex);
  // Symmetry: Bob→Alice gives the same key
  const keyReverse = deriveSessionKey({
    localPrivateKeyPem: v.bobPrivateKeyPem,
    remotePublicKeyPem: v.alicePublicKeyPem,
    senderDeviceId: v.senderDeviceId,
    receiverDeviceId: v.receiverDeviceId,
    taskId: v.taskId,
    manifestSha256: v.manifestSha256,
  });
  assert.equal(keyReverse.toString('hex'), v.sessionKeyHex);
});

// ─── Vector 3: Chunk encryption ─────────────────────────────────────────────
test('vector: chunk decryption matches reference plaintext', () => {
  const v = cryptoVectors.chunkEncryption;
  const key = Buffer.from(v.sessionKeyHex, 'hex');
  const plaintext = decryptChunk({
    key,
    nonce: Buffer.from(v.nonceHex, 'hex'),
    taskId: v.taskId,
    path: v.path,
    offset: v.offset,
    sequence: v.sequence,
    plainLength: Buffer.from(v.plaintextHex, 'hex').length,
    ciphertext: Buffer.from(v.ciphertextHex, 'hex'),
    authTag: Buffer.from(v.authTagHex, 'hex'),
  });
  assert.equal(plaintext.toString('utf8'), v.plaintextUtf8);
});

test('vector: chunk AAD matches reference bytes', () => {
  const v = cryptoVectors.chunkEncryption;
  const aad = buildChunkAad({
    taskId: v.taskId,
    path: v.path,
    offset: v.offset,
    sequence: v.sequence,
    plainLength: Buffer.from(v.plaintextHex, 'hex').length,
  });
  assert.equal(aad.toString('hex'), v.aadHex);
});

// ─── Vector 4: SAS pairing code ─────────────────────────────────────────────
test('vector: SAS pairing code derivation matches reference', () => {
  const v = pairingVectors.pairingCode;
  const code = derivePairingCode({
    pairingId: v.pairingId,
    initiator: v.initiator,
    responder: v.responder,
  });
  assert.equal(code, v.pairingCode);
  assert.match(code, /^[0-9]{6}$/);
  // Transcript matches
  assert.equal(
    canonicalJson({
      app: 'nearby-transfer',
      protocolVersion: 2,
      type: 'pairing-code',
      pairingId: v.pairingId,
      initiator: publicIdentity(v.initiator),
      responder: publicIdentity(v.responder),
    } as unknown as CanonicalValue),
    v.transcript,
  );
});

// ─── Vector 5: Pairing offer signature ──────────────────────────────────────
test('vector: pairing offer signature verifies against initiator key', () => {
  const v = pairingVectors.pairingOfferSignature;
  assert.equal(verifyPairingOffer(v.offer, v.signature), true);
  // Tampered signature fails
  assert.equal(verifyPairingOffer(v.offer, v.signature.slice(0, -4) + 'AAAA'), false);
  // Signing payload matches canonical JSON of the offer fields
  assert.equal(
    canonicalJson({
      app: v.offer.app,
      protocolVersion: v.offer.protocolVersion,
      type: v.offer.type,
      pairingId: v.offer.pairingId,
      issuedAt: v.offer.issuedAt,
      identity: publicIdentity(v.offer.identity),
      capabilities: v.offer.capabilities,
    } as unknown as CanonicalValue),
    v.signingPayload,
  );
});

// ─── Vector 6: Canonical JSON ───────────────────────────────────────────────
test('vector: canonical JSON serialization matches reference', () => {
  const v = transferVectors.canonicalJson;
  assert.equal(canonicalJson(v.input as unknown as CanonicalValue), v.output);
});

// ─── Vector 7: Wire frame encoding ──────────────────────────────────────────
test('vector: wire frame decoding matches reference', () => {
  const v = transferVectors.wireFrame;
  const frame = decodeWireFrame(Buffer.from(v.frameHex, 'hex'));
  assert.deepEqual(frame.header, v.header);
  assert.equal(frame.payload.toString('hex'), v.payloadHex);
});

// ─── Vector 8: Chunk frame encoding ─────────────────────────────────────────
test('vector: chunk frame decoding matches reference', () => {
  const v = transferVectors.chunkFrame;
  const frame = decodeFrame(Buffer.from(v.frameHex, 'hex'));
  assert.equal(frame.taskId, v.taskId);
  assert.equal(frame.relativePath, v.relativePath);
  assert.equal(frame.offset, v.offset);
  assert.equal(frame.sequence, v.sequence);
  assert.equal(frame.plainLength, v.plainLength);
  assert.equal(Buffer.from(frame.nonce).toString('hex'), v.nonceHex);
  assert.equal(Buffer.from(frame.authTag).toString('hex'), v.authTagHex);
  assert.equal(Buffer.from(frame.ciphertext).toString('hex'), v.ciphertextHex);
});

// ─── Vector 9: Discovery announcement signature ─────────────────────────────
test('vector: discovery announcement signature verifies', () => {
  const v = transferVectors.discoverySignature;
  assert.equal(verifyDiscoveryAnnouncement(v.announcement, v.signature), true);
  // Tampered signature fails
  assert.equal(verifyDiscoveryAnnouncement(v.announcement, v.signature.slice(0, -4) + 'AAAA'), false);
  // Signing payload matches canonical JSON of the announcement minus signature
  assert.equal(
    canonicalJson({
      app: v.announcement.app,
      protocolVersion: v.announcement.protocolVersion,
      type: v.announcement.type,
      issuedAt: v.announcement.issuedAt,
      identity: publicIdentity(v.announcement.identity),
      port: v.announcement.port,
      capabilities: v.announcement.capabilities,
    } as unknown as CanonicalValue),
    v.signingPayload,
  );
});

// ─── Vector 10: TransferManifest serialization ───────────────────────────────
test('vector: manifest serialization matches reference', () => {
  const v = transferVectors.manifestSerialization;
  assert.equal(serializeTransferManifest(v.manifest), v.serialized);
  // Re-serialization is idempotent
  assert.equal(serializeTransferManifest(v.manifest), v.serialized);
});

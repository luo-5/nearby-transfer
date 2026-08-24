/**
 * Pairing layer tests for @luo-5/core.
 *
 * Validates SAS pairing code derivation against the existing deterministic
 * fixture (test/fixtures/protocol-v2-pairing.json), offer/confirmation/cancel
 * sign+verify round-trips, and JSON trust/session store CRUD.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Buffer } from 'node:buffer';

import {
  createEd25519KeyPair,
  createX25519KeyPair,
  deriveDeviceId,
  fingerprintFor,
  derivePairingCode,
  pairingCodeTranscript,
  createPairingId,
  createPairingOffer,
  createPairingConfirmation,
  createPairingCancel,
  signPairingOffer,
  verifyPairingOffer,
  signPairingConfirmation,
  verifyPairingConfirmation,
  signPairingCancel,
  verifyPairingCancel,
  JsonTrustStore,
  JsonSessionStore,
} from '../src/index.js';
import type { PairingDevice, TrustRecord } from '../src/index.js';

function makeDevice(): PairingDevice {
  const signing = createEd25519KeyPair();
  const encryption = createX25519KeyPair();
  return {
    deviceId: deriveDeviceId(signing.publicKey),
    deviceName: 'test-device',
    fingerprint: fingerprintFor(signing.publicKey),
    signingPublicKey: signing.publicKey,
    encryptionPublicKey: encryption.publicKey,
    signingPrivateKey: signing.privateKey,
  };
}

// Reuse the existing deterministic pairing fixture from the desktop test suite.
const fixturePath = join(process.cwd(), 'test', 'fixtures', 'protocol-v2-pairing.json');
let fixture: { pairingCode: { pairingId: string; initiator: unknown; responder: unknown; expectedTranscript: string; expectedCode: string } } | null = null;
try {
  fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
} catch {
  // Fixture not available in this cwd — tests below skip gracefully.
}

test('pairing: derivePairingCode matches the deterministic fixture vector', { skip: fixture === null }, () => {
  const v = fixture!.pairingCode;
  const context = {
    pairingId: v.pairingId,
    initiator: v.initiator as Parameters<typeof derivePairingCode>[0]['initiator'],
    responder: v.responder as Parameters<typeof derivePairingCode>[0]['responder'],
  };
  assert.equal(pairingCodeTranscript(context), v.expectedTranscript);
  assert.equal(derivePairingCode(context), v.expectedCode);
});

test('pairing: derivePairingCode produces a 6-digit string', () => {
  const initiator = makeDevice();
  const responder = makeDevice();
  const code = derivePairingCode({ pairingId: createPairingId(), initiator, responder });
  assert.match(code, /^[0-9]{6}$/);
});

test('pairing: same context always derives the same code', () => {
  const initiator = makeDevice();
  const responder = makeDevice();
  const pairingId = createPairingId();
  const c1 = derivePairingCode({ pairingId, initiator, responder });
  const c2 = derivePairingCode({ pairingId, initiator, responder });
  assert.equal(c1, c2);
});

test('pairing: swapping initiator/responder gives a different code', () => {
  const initiator = makeDevice();
  const responder = makeDevice();
  const pairingId = createPairingId();
  const c1 = derivePairingCode({ pairingId, initiator, responder });
  const c2 = derivePairingCode({ pairingId, initiator: responder, responder: initiator });
  assert.notEqual(c1, c2);
});

test('pairing: createPairingId is 22-char base64url', () => {
  const id = createPairingId();
  assert.match(id, /^[A-Za-z0-9_-]{22}$/);
});

test('pairing: offer sign and verify round-trips', () => {
  const device = makeDevice();
  const offer = createPairingOffer({ device, capabilities: ['v2-stream'] });
  const signature = signPairingOffer(offer, device.signingPrivateKey);
  assert.equal(verifyPairingOffer(offer, signature), true);
  assert.equal(verifyPairingOffer(offer, undefined), false);
  assert.equal(verifyPairingOffer(offer, 'aW52YWxpZA=='), false);
});

test('pairing: confirmation sign and verify round-trips', () => {
  const device = makeDevice();
  const initiator = makeDevice();
  const code = derivePairingCode({ pairingId: createPairingId(), initiator, responder: device });
  const confirmation = createPairingConfirmation({ pairingId: createPairingId(), device, pairingCode: code });
  const signature = signPairingConfirmation(confirmation, device.signingPrivateKey);
  assert.equal(verifyPairingConfirmation(confirmation, signature, device.signingPublicKey), true);
  assert.equal(verifyPairingConfirmation(confirmation, signature, initiator.signingPublicKey), false);
});

test('pairing: cancel sign and verify round-trips', () => {
  const device = makeDevice();
  const cancel = createPairingCancel({ pairingId: createPairingId(), device, reason: 'user-cancelled' });
  const signature = signPairingCancel(cancel, device.signingPrivateKey);
  assert.equal(verifyPairingCancel(cancel, signature, device.signingPublicKey), true);
});

test('pairing: cancel rejects invalid reason', () => {
  const device = makeDevice();
  assert.throws(
    () => createPairingCancel({ pairingId: createPairingId(), device, reason: 'bogus' }),
    /reason is invalid/,
  );
});

test('trust store: save, get, load, remove, clear (JSON file)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nt-trust-'));
  try {
    const store = new JsonTrustStore(dir);
    const record: TrustRecord = {
      deviceId: 'a1b2c3d4e5f60718',
      name: 'peer-1',
      signingPublicKey: new Uint8Array(32),
      trustedAt: Date.now(),
    };
    await store.save(record);
    const got = await store.get(record.deviceId);
    assert.deepEqual(got, record);

    const all = await store.load();
    assert.equal(all.length, 1);

    await store.remove(record.deviceId);
    assert.equal(await store.get(record.deviceId), null);
    assert.equal((await store.load()).length, 0);

    // clear on empty is fine
    await store.clear();
    assert.ok(existsSync(join(dir, 'trusted-peers.json')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('trust store: save updates existing record', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nt-trust2-'));
  try {
    const store = new JsonTrustStore(dir);
    const deviceId = '0123456789abcdef';
    await store.save({ deviceId, name: 'old', signingPublicKey: new Uint8Array(32), trustedAt: 1000 });
    await store.save({ deviceId, name: 'new', signingPublicKey: new Uint8Array(32), trustedAt: 2000 });
    const got = await store.get(deviceId);
    assert.equal(got?.name, 'new');
    assert.equal(got?.trustedAt, 2000);
    assert.equal((await store.load()).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('session store: save, get, remove, clear (JSON file)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nt-session-'));
  try {
    const store = new JsonSessionStore(dir);
    const pairingId = createPairingId();
    const session = { state: 'awaiting-confirmation', deviceId: 'a1b2c3d4e5f60718' };
    await store.save(pairingId, session);
    const got = await store.get(pairingId);
    assert.deepEqual(got, session);

    await store.remove(pairingId);
    assert.equal(await store.get(pairingId), null);

    await store.clear();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('session store: rejects invalid pairingId', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nt-session2-'));
  try {
    const store = new JsonSessionStore(dir);
    await assert.rejects(() => store.get('short'), /base64url/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

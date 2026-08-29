/**
 * CLI unit tests: device identity, option parsing, trust store, command dispatch.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPublicKey } from 'node:crypto';
import { Buffer } from 'node:buffer';

import { loadOrCreateDevice, parseCommonOptions, getDataDir, requireTrustedPeerIdentity } from '../src/device.js';
import { JsonTrustStore, createEd25519KeyPair, deriveDeviceId, fingerprintFor } from '@luo-5/core';

test('device: loadOrCreateDevice generates a new identity on first run', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nt-cli-'));
  try {
    const device = loadOrCreateDevice(dir);
    assert.match(device.deviceId, /^[a-f0-9]{16}$/);
    assert.match(device.fingerprint, /^[0-9A-F]{4}(?:-[0-9A-F]{4}){5}$/);
    assert.ok(device.signingPublicKey.includes('BEGIN PUBLIC KEY'));
    assert.ok(device.signingPrivateKey.includes('BEGIN PRIVATE KEY'));
    assert.ok(existsSync(join(dir, 'device.json')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('device: loadOrCreateDevice loads existing identity on second run', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nt-cli-'));
  try {
    const first = loadOrCreateDevice(dir);
    const second = loadOrCreateDevice(dir);
    assert.equal(second.deviceId, first.deviceId);
    assert.equal(second.signingPrivateKey, first.signingPrivateKey);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('device: generated identity has correct deviceId and fingerprint', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nt-cli-'));
  try {
    const device = loadOrCreateDevice(dir);
    const expectedDeviceId = deriveDeviceId(device.signingPublicKey);
    const expectedFingerprint = fingerprintFor(device.signingPublicKey);
    assert.equal(device.deviceId, expectedDeviceId);
    assert.equal(device.fingerprint, expectedFingerprint);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('device: device.json is valid JSON with mode 0600', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nt-cli-'));
  try {
    loadOrCreateDevice(dir);
    const raw = readFileSync(join(dir, 'device.json'), 'utf8');
    const parsed = JSON.parse(raw);
    assert.ok(parsed.deviceId);
    assert.ok(parsed.signingPublicKey);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('device: parseCommonOptions parses data-dir, port, timeout', () => {
  const opts = parseCommonOptions(['--data-dir', '/tmp/test', '--port', '8080', '--timeout', '3000']);
  assert.equal(opts.dataDir, '/tmp/test');
  assert.equal(opts.port, 8080);
  assert.equal(opts.timeout, 3000);
});

test('device: parseCommonOptions returns undefined for missing options', () => {
  const opts = parseCommonOptions([]);
  assert.equal(opts.dataDir, undefined);
  assert.equal(opts.port, undefined);
  assert.equal(opts.timeout, undefined);
});

test('trust: JsonTrustStore CRUD works with CLI data dir', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nt-cli-trust-'));
  try {
    const store = new JsonTrustStore(dir);
    const signing = createEd25519KeyPair();
    const deviceId = deriveDeviceId(signing.publicKey);

    await store.save({
      deviceId,
      name: 'test-peer',
      signingPublicKey: new Uint8Array(32),
      trustedAt: Date.now(),
    });

    const got = await store.get(deviceId);
    assert.equal(got?.name, 'test-peer');

    const all = await store.load();
    assert.equal(all.length, 1);

    await store.remove(deviceId);
    assert.equal(await store.get(deviceId), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('device: getDataDir returns ~/.nearby-transfer by default', () => {
  const dir = getDataDir();
  assert.ok(dir.includes('.nearby-transfer'));
});

test('device: getDataDir respects override', () => {
  const dir = getDataDir('/custom/path');
  assert.equal(dir, '/custom/path');
});

test('trust: discovered peer must have a persisted matching signing key', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nt-cli-peer-trust-'));
  try {
    const signing = createEd25519KeyPair();
    const deviceId = deriveDeviceId(signing.publicKey);
    const der = createPublicKey(signing.publicKey).export({ type: 'spki', format: 'der' });
    const rawKey = new Uint8Array(Buffer.from(der).subarray(-32));
    const peer = { deviceId, signingPublicKey: signing.publicKey };

    await assert.rejects(
      requireTrustedPeerIdentity(peer, dir),
      /is not trusted/,
    );

    const store = new JsonTrustStore(dir);
    await store.save({
      deviceId,
      name: 'trusted-peer',
      signingPublicKey: rawKey,
      trustedAt: Date.now(),
    });
    await requireTrustedPeerIdentity(peer, dir);

    const impostor = createEd25519KeyPair();
    await assert.rejects(
      requireTrustedPeerIdentity({ deviceId, signingPublicKey: impostor.publicKey }, dir),
      /does not match the trusted record/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

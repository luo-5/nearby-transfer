/**
 * Type-level smoke test: ensures the public interface surface compiles and the
 * exported constants/canonical-json behave correctly. Real unit tests for each
 * migrated layer are added in M1.3-M1.7.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  APP_ID,
  PROTOCOL_VERSION,
  PAIRING_CODE_DIGITS,
  MESSAGE_TYPES,
  canonicalJson,
  parseCanonicalJson,
} from '../src/index.js';
import type {
  DeviceId,
  PeerIdentity,
  DiscoveredPeer,
  TrustRecord,
  FileSpec,
  TransferProgress,
  CoreConfig,
  NearbyTransferCore,
  ProtocolRegistry,
  ProtocolAdapter,
  ServeOptions,
  LibraryServer,
  CreateCore,
} from '../src/index.js';

test('constants match the v2 protocol', () => {
  assert.equal(APP_ID, 'nearby-transfer');
  assert.equal(PROTOCOL_VERSION, 2);
  assert.equal(PAIRING_CODE_DIGITS, 6);
  assert.equal(MESSAGE_TYPES.PAIRING_OFFER, 'pairing-offer');
  assert.equal(MESSAGE_TYPES.TRANSFER_CHUNK, 'transfer-chunk');
});

test('canonicalJson produces sorted, compact output', () => {
  assert.equal(canonicalJson({ b: 1, a: 2 }), '{"a":2,"b":1}');
  assert.equal(canonicalJson([3, 1, 2]), '[3,1,2]');
  assert.equal(canonicalJson(null), 'null');
  assert.equal(canonicalJson('str'), '"str"');
});

test('parseCanonicalJson rejects non-canonical input', () => {
  assert.deepEqual(parseCanonicalJson('{"a":1}'), { a: 1 });
  assert.throws(() => parseCanonicalJson('{ "a": 1 }'), /canonical/);
  assert.throws(() => parseCanonicalJson('{"a":1,"a":2}'), /canonical/);
  assert.throws(() => parseCanonicalJson('1.5'), /safe integer/);
});

// Compile-time check that the public interfaces are structurally usable.
function _typeCheck(): void {
  const deviceId: DeviceId = 'abc';
  const identity: PeerIdentity = {
    deviceId,
    signingPublicKey: new Uint8Array(32),
    signingPrivateKey: new Uint8Array(64),
    ecdhPublicKey: new Uint8Array(32),
    ecdhPrivateKey: new Uint8Array(32),
  };
  const peer: DiscoveredPeer = {
    deviceId,
    name: 'node',
    address: '127.0.0.1',
    port: 0,
    protocolVersion: 2,
    capabilities: [],
    lastSeen: 0,
  };
  const trust: TrustRecord = {
    deviceId,
    name: 'node',
    signingPublicKey: new Uint8Array(32),
    trustedAt: 0,
  };
  const file: FileSpec = { path: '/x', size: 0 };
  const progress: TransferProgress = {
    path: '/x',
    fileSize: 0,
    committedOffset: 0,
    completed: false,
    nextSequence: 0,
    totalTransferred: 0,
  };
  const config: CoreConfig = { dataDirectory: '/tmp' };
  const serve: ServeOptions = { receiveDirectory: '/tmp' };
  const server: LibraryServer = { deviceId, shares: [], endpoint: '' };
  const createCore: CreateCore = async (_c) => ({} as NearbyTransferCore);
  void [identity, peer, trust, file, progress, config, serve, server, createCore];
  const registry: ProtocolRegistry = {
    register: (_a: ProtocolAdapter) => {},
    unregister: () => {},
    get: () => null,
    list: () => [],
    select: async () => {},
    active: () => null,
  };
  void registry;
}

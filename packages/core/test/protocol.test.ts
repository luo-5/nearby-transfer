/**
 * Protocol registry tests for @nearby-transfer/core.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ProtocolEngine, PROTOCOLS, CATEGORIES, BaseProtocolDriver } from '../src/index.js';

test('protocol: engine registers all 7 default drivers', () => {
  const engine = new ProtocolEngine();
  const list = engine.listProtocols();
  assert.equal(list.length, 7);
  const ids = list.map((p) => p.id).sort();
  assert.ok(ids.includes(PROTOCOLS.V2_STREAM));
  assert.ok(ids.includes(PROTOCOLS.TURBO_PARALLEL));
  assert.ok(ids.includes(PROTOCOLS.FTPS_SECURE));
});

test('protocol: default active protocol is v2-stream', () => {
  const engine = new ProtocolEngine();
  assert.equal(engine.activeProtocolId, PROTOCOLS.V2_STREAM);
  const current = engine.getActiveDriver();
  assert.equal(current.id, PROTOCOLS.V2_STREAM);
});

test('protocol: listProtocols filters by category', () => {
  const engine = new ProtocolEngine();
  const fast = engine.listProtocols(CATEGORIES.FAST);
  assert.ok(fast.length >= 2);
  assert.ok(fast.every((p) => p.category === CATEGORIES.FAST));
});

test('protocol: setActiveProtocol switches the active driver', async () => {
  const engine = new ProtocolEngine();
  const result = await engine.setActiveProtocol(PROTOCOLS.TURBO_PARALLEL);
  assert.equal(result.ok, true);
  assert.equal(result.previous, PROTOCOLS.V2_STREAM);
  assert.equal(result.active, PROTOCOLS.TURBO_PARALLEL);
  assert.equal(engine.activeProtocolId, PROTOCOLS.TURBO_PARALLEL);
});

test('protocol: setActiveProtocol rejects unknown protocol', async () => {
  const engine = new ProtocolEngine();
  await assert.rejects(() => engine.setActiveProtocol('nonexistent'), /Unsupported protocol/);
});

test('protocol: custom driver can be registered', () => {
  class CustomDriver extends BaseProtocolDriver {
    constructor() { super('custom', 'Custom', CATEGORIES.STANDARD, 1234); }
  }
  const engine = new ProtocolEngine();
  engine.register(new CustomDriver());
  assert.ok(engine.get('custom'));
  assert.equal(engine.get('custom')!.name, 'Custom');
});

'use strict';

const assert = require('assert');
const { registerLanServiceIpcHandlers } = require('../src/v2/desktop-lan-api');

const peer = {
  deviceId: '0123456789abcdef',
  deviceName: 'Nearby Android',
  fingerprint: '0123-4567-89AB-CDEF-0123-4567',
  host: '192.168.1.10',
  port: 47778,
  capabilities: ['pairing'],
  lastSeen: 1760000000000
};
const calls = [];
const service = {
  listPeers: () => [peer],
  startPairing: async (selected, options) => { calls.push(['start', selected, options]); return { pairingId: 'AQIDBAUGBwgJCgsMDQ4PEA' }; },
  confirmPairing: (id) => { calls.push(['confirm', id]); return { pairingId: id }; },
  completePairing: (id, options) => { calls.push(['complete', id, options]); return { deviceId: peer.deviceId }; },
  cancelPairing: (id) => { calls.push(['cancel', id]); return true; }
};
const handlers = new Map();
registerLanServiceIpcHandlers({ handle: (channel, handler) => handlers.set(channel, handler) }, service);
assert.deepStrictEqual(Array.from(handlers.keys()).sort(), [
  'v2:cancel-network-pairing',
  'v2:complete-network-pairing',
  'v2:confirm-network-pairing',
  'v2:list-discovered-peers',
  'v2:start-network-pairing'
]);
const publicPeer = handlers.get('v2:list-discovered-peers')()[0];
assert.strictEqual(Object.hasOwn(publicPeer, 'host'), false);
assert.strictEqual(Object.hasOwn(publicPeer, 'signingPublicKey'), false);
(async () => {
  await handlers.get('v2:start-network-pairing')(null, { peerDeviceId: peer.deviceId, capabilities: ['pairing'] });
  handlers.get('v2:confirm-network-pairing')(null, 'AQIDBAUGBwgJCgsMDQ4PEA');
  handlers.get('v2:complete-network-pairing')(null, { pairingId: 'AQIDBAUGBwgJCgsMDQ4PEA', permissions: { transfer: true } });
  handlers.get('v2:cancel-network-pairing')(null, 'AQIDBAUGBwgJCgsMDQ4PEA');
  assert.deepStrictEqual(calls[0], ['start', peer, { capabilities: ['pairing'] }]);
  assert.deepStrictEqual(calls[2], ['complete', 'AQIDBAUGBwgJCgsMDQ4PEA', { displayName: undefined, permissions: { transfer: true } }]);
  assert.throws(() => handlers.get('v2:complete-network-pairing')(null, { pairingId: 'x', permissions: { admin: true } }), /Permissions/);
  console.log('desktop LAN API smoke tests passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
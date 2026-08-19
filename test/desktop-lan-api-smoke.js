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
  startPairing: async (selected, options) => { calls.push(['start', selected, options]); return session('AQIDBAUGBwgJCgsMDQ4PEA'); },
  confirmPairing: (id) => { calls.push(['confirm', id]); return session(id); },
  completePairing: (id, options) => { calls.push(['complete', id, options]); return trustedPeer(); },
  cancelPairing: (id) => { calls.push(['cancel', id]); return true; }
};
function session(pairingId) {
  return {
    pairingId, role: 'initiator', status: 'awaiting-local-confirmation',
    peer: { identity: { deviceId: peer.deviceId, deviceName: peer.deviceName, fingerprint: peer.fingerprint, signingPublicKey: 'secret-signing-key', encryptionPublicKey: 'secret-encryption-key' } },
    pairingCode: '123456', createdAt: 1, expiresAt: 2
  };
}
function trustedPeer() {
  return {
    identity: { deviceId: peer.deviceId, deviceName: peer.deviceName, fingerprint: peer.fingerprint, signingPublicKey: 'secret-signing-key', encryptionPublicKey: 'secret-encryption-key' },
    displayName: peer.deviceName, permissions: { transfer: true }, pairedAt: 1, revokedAt: null, updatedAt: 2
  };
}
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
  const publicSession = await handlers.get('v2:confirm-network-pairing')(null, 'AQIDBAUGBwgJCgsMDQ4PEA');
  const publicTrustedPeer = await handlers.get('v2:complete-network-pairing')(null, { pairingId: 'AQIDBAUGBwgJCgsMDQ4PEA', permissions: { transfer: true } });
  assert.strictEqual(Object.hasOwn(publicSession.peer, 'signingPublicKey'), false);
  assert.strictEqual(Object.hasOwn(publicTrustedPeer, 'signingPublicKey'), false);
  handlers.get('v2:cancel-network-pairing')(null, 'AQIDBAUGBwgJCgsMDQ4PEA');
  assert.deepStrictEqual(calls[0], ['start', peer, { capabilities: ['pairing'] }]);
  assert.deepStrictEqual(calls[2], ['complete', 'AQIDBAUGBwgJCgsMDQ4PEA', { displayName: undefined, permissions: { transfer: true } }]);
  assert.throws(() => handlers.get('v2:complete-network-pairing')(null, { pairingId: 'x', permissions: { admin: true } }), /Permissions/);
  console.log('desktop LAN API smoke tests passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
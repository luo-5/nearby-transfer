import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';

import { LanService } from '../src/index.js';

test('LAN service resets a failed listen attempt and can retry', { timeout: 5_000 }, async () => {
  const blocker = net.createServer();
  await new Promise<void>((resolve) => blocker.listen(0, '0.0.0.0', resolve));
  const address = blocker.address();
  assert.ok(address && typeof address === 'object');
  const pairingApi = {
    startPairing() { return {}; },
    createLocalConfirmation() { return {}; },
    createResponderOffer() { return {}; },
    getPairingSession() { return null; },
    listPairingSessions() { return []; },
    receiveIncomingOffer() { return {}; },
    receiveRemoteOffer() { return {}; },
    receiveRemoteConfirmation() { return {}; },
    complete() { return {}; },
    cancel() { return {}; },
  };
  const service = new LanService({
    device: { deviceId: '0123456789abcdef', signingPrivateKey: 'unused' } as never,
    pairingApi: pairingApi as never,
    enableDiscovery: false,
  });
  try {
    let listenError: NodeJS.ErrnoException | null = null;
    try { await service.start(address.port); } catch (error) { listenError = error as NodeJS.ErrnoException; }
    assert.equal(listenError?.code, 'EADDRINUSE');
    await new Promise<void>((resolve) => blocker.close(() => resolve()));
    const port = await service.start(0);
    assert.ok(port > 0);
  } finally {
    if (blocker.listening) await new Promise<void>((resolve) => blocker.close(() => resolve()));
    await service.stop();
  }
});

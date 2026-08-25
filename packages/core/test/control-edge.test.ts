import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createSignedStreamControlCodec } from '../src/transfer/control.js';
import { createEd25519KeyPair, deriveDeviceId } from '../src/crypto/identity.js';

describe('control edge tests', () => {
  const aliceEd = createEd25519KeyPair();
  const bobEd = createEd25519KeyPair();
  const aliceId = deriveDeviceId(aliceEd.publicKey);
  const bobId = deriveDeviceId(bobEd.publicKey);
  const taskId = 'de3U6QplW7_X2w7pwGDibA';
  const sessionId = 'EREREREREREREREREREREQ';

  function makeCodec(clock = () => 1000000) {
    const senderCodec = createSignedStreamControlCodec({
      localDevice: { deviceId: aliceId, signingPrivateKey: aliceEd.privateKey, signingPublicKey: aliceEd.publicKey },
      remotePeer: { deviceId: bobId, signingPublicKey: bobEd.publicKey },
      taskId,
      sessionId,
      now: clock,
    });
    const receiverCodec = createSignedStreamControlCodec({
      localDevice: { deviceId: bobId, signingPrivateKey: bobEd.privateKey, signingPublicKey: bobEd.publicKey },
      remotePeer: { deviceId: aliceId, signingPublicKey: aliceEd.publicKey },
      taskId,
      sessionId,
      now: clock,
    });
    return { senderCodec, receiverCodec };
  }

  it('rejects out-of-order sequence numbers', () => {
    const { senderCodec, receiverCodec } = makeCodec();

    const hello = senderCodec.encodeControl({
      type: 'stream-hello',
      protocol: 1,
      taskId,
      fromPeerId: aliceId,
      toPeerId: bobId,
      direction: 'send',
    });

    const start = senderCodec.encodeControl({
      type: 'stream-start',
      protocol: 1,
      taskId,
      fromPeerId: aliceId,
      toPeerId: bobId,
      direction: 'send',
    });

    // Try decoding start before hello (sequence 1 instead of expected 0)
    assert.throws(() => receiverCodec.decodeControl(start), /sequence must be exactly 0/i);

    // Decode hello (seq 0) -> succeeds
    const decodedHello = receiverCodec.decodeControl(hello);
    assert.equal(receiverCodec.verifyControl(decodedHello), true);

    // Now seq 1 succeeds
    const decodedStart = receiverCodec.decodeControl(start);
    assert.equal(receiverCodec.verifyControl(decodedStart), true);
  });

  it('rejects expired control messages', () => {
    let time = 1000000;
    const { senderCodec, receiverCodec } = makeCodec(() => time);

    const hello = senderCodec.encodeControl({
      type: 'stream-hello',
      protocol: 1,
      taskId,
      fromPeerId: aliceId,
      toPeerId: bobId,
      direction: 'send',
    });

    // Advance time past TTL (30s) + clock skew (30s) = 65s
    time += 65000;
    assert.throws(() => receiverCodec.decodeControl(hello), /expired/i);
  });

  it('rejects messages for mismatched taskId or sessionId', () => {
    const { senderCodec } = makeCodec();
    const otherReceiverCodec = createSignedStreamControlCodec({
      localDevice: { deviceId: bobId, signingPrivateKey: bobEd.privateKey },
      remotePeer: { deviceId: aliceId, signingPublicKey: aliceEd.publicKey },
      taskId: 'AAAAAAAAAAAAAAAAAAAAAA', // wrong taskId
      sessionId,
      now: () => 1000000,
    });

    const hello = senderCodec.encodeControl({
      type: 'stream-hello',
      protocol: 1,
      taskId,
      fromPeerId: aliceId,
      toPeerId: bobId,
      direction: 'send',
    });

    assert.throws(() => otherReceiverCodec.decodeControl(hello), /task does not match/i);
  });
});

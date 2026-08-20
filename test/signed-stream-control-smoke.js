'use strict';

const assert = require('assert');
const crypto = require('crypto');
const { canonicalJson } = require('../src/v2/canonical-json');
const { APP_ID, MESSAGE_TYPES, PROTOCOL_VERSION } = require('../src/v2/constants');
const { createSignedStreamControlCodec } = require('../src/v2/signed-stream-control');
const authFixture = require('./fixtures/protocol-v2-transfer-auth.json');

const NOW = 1760000000000;
const TASK_ID = 'AQIDBAUGBwgJCgsMDQ4PEA';

function main() {
  testSharedCrossPlatformVector();
  testBidirectionalRoundTripAndCanonicalSignature();
  testCancellation();
  testTamperingAndWrongBindings();
  testTimeBounds();
  testStrictCanonicalInput();
  testReplayAndOrdering();
  console.log('signed stream control smoke tests passed');
}

function testSharedCrossPlatformVector() {
  const { sender, receiver, streamControl, taskId, validationNow } = authFixture;
  assert.strictEqual(
    crypto.createHash('sha256').update(sender.signingPublicKey).digest('hex').slice(0, 16),
    sender.deviceId
  );
  assert.strictEqual(
    crypto.createHash('sha256').update(receiver.signingPublicKey).digest('hex').slice(0, 16),
    receiver.deviceId
  );

  const senderCodec = createSignedStreamControlCodec({
    localDevice: sender,
    remotePeer: receiver,
    taskId,
    now: () => validationNow
  });
  assert.strictEqual(
    senderCodec.encodeControl(streamControl.core).toString('utf8'),
    streamControl.canonicalSigned
  );

  const receiverCodec = createSignedStreamControlCodec({
    localDevice: receiver,
    remotePeer: sender,
    taskId,
    now: () => validationNow
  });
  const decoded = receiverCodec.decodeControl(Buffer.from(streamControl.canonicalSigned, 'utf8'));
  assert.deepStrictEqual(decoded, streamControl.core);
  assert.strictEqual(receiverCodec.verifyControl(decoded), true);
}

function testBidirectionalRoundTripAndCanonicalSignature() {
  const desktop = createDevice('1111111111111111');
  const android = createDevice('2222222222222222');
  const desktopCodec = codec(desktop, android);
  const androidCodec = codec(android, { identity: desktop });

  const helloBytes = desktopCodec.encodeControl(core('stream-hello', desktop, android, 'send'));
  const signedHello = JSON.parse(helloBytes.toString('utf8'));
  assert.strictEqual(helloBytes.toString('utf8'), canonicalJson(signedHello));
  assert.strictEqual(signedHello.app, APP_ID);
  assert.strictEqual(signedHello.protocolVersion, PROTOCOL_VERSION);
  assert.strictEqual(signedHello.type, MESSAGE_TYPES.TRANSFER_STREAM_CONTROL);
  assert.strictEqual(signedHello.sequence, 0);
  assert.strictEqual(signedHello.expiresAt - signedHello.issuedAt, 30000);
  assert.match(signedHello.signature, /^[A-Za-z0-9_-]{86}$/);
  assert.strictEqual(Buffer.from(signedHello.signature, 'base64url').length, 64);

  const signature = Buffer.from(signedHello.signature, 'base64url');
  const unsigned = { ...signedHello };
  delete unsigned.signature;
  assert.strictEqual(crypto.verify(
    null,
    Buffer.from(canonicalJson(unsigned), 'utf8'),
    crypto.createPublicKey(desktop.signingPublicKey),
    signature
  ), true);

  const remoteHello = androidCodec.decodeControl(helloBytes);
  assert.deepStrictEqual(remoteHello, core('stream-hello', desktop, android, 'send'));
  assert.strictEqual(androidCodec.verifyControl(remoteHello), true);
  assert.strictEqual(androidCodec.verifyControl(remoteHello), false, 'authenticated values are single-use');
  assert.strictEqual(androidCodec.verifyControl({ ...remoteHello }), false, 'copies are not authenticated');

  const replyBytes = androidCodec.encodeControl(core('stream-hello', android, desktop, 'receive'));
  const reply = desktopCodec.decodeControl(replyBytes);
  assert.deepStrictEqual(reply, core('stream-hello', android, desktop, 'receive'));
  assert.strictEqual(desktopCodec.verifyControl(reply), true);

  const start = androidCodec.decodeControl(
    desktopCodec.encodeControl(core('stream-start', desktop, android, 'send'))
  );
  assert.strictEqual(androidCodec.verifyControl(start), true);
}

function testCancellation() {
  const left = createDevice('3333333333333333');
  const right = createDevice('4444444444444444');
  const sender = codec(left, right);
  const receiver = codec(right, left);
  const cancelCore = { ...core('stream-cancel', left, right, 'send'), code: 'timeout' };
  const bytes = sender.encodeControl(cancelCore);
  const signed = JSON.parse(bytes.toString('utf8'));
  assert.strictEqual(signed.code, 'timeout');
  const decoded = receiver.decodeControl(bytes);
  assert.deepStrictEqual(decoded, cancelCore);
  assert.strictEqual(receiver.verifyControl(decoded), true);
  assert.throws(
    () => sender.encodeControl({ ...core('stream-start', left, right, 'send'), code: 'timeout' }),
    /unknown field/
  );
  assert.throws(
    () => sender.encodeControl({ ...cancelCore, code: 'other' }),
    /cancellation code/
  );
}

function testTamperingAndWrongBindings() {
  const left = createDevice('5555555555555555');
  const right = createDevice('6666666666666666');
  const impostor = createDevice('7777777777777777');
  const bytes = codec(left, right).encodeControl(core('stream-hello', left, right, 'send'));

  const tampered = JSON.parse(bytes.toString('utf8'));
  tampered.command = 'stream-complete';
  assert.throws(() => codec(right, left).decodeControl(Buffer.from(canonicalJson(tampered))), /signature/);

  assert.throws(
    () => codec(right, { ...left, signingPublicKey: impostor.signingPublicKey }).decodeControl(bytes),
    /signature/
  );
  assert.throws(
    () => codec(right, impostor).decodeControl(bytes),
    /identities/
  );
  assert.throws(
    () => createSignedStreamControlCodec({
      localDevice: right,
      remotePeer: left,
      taskId: 'ERITFBUWFxgZGhscHR4fIA',
      now: () => NOW
    }).decodeControl(bytes),
    /task/
  );

  const wrongPeer = signedWire(left, {
    fromDeviceId: impostor.deviceId,
    toDeviceId: right.deviceId
  });
  assert.throws(() => codec(right, left).decodeControl(wrongPeer), /identities/);
  const wrongTask = signedWire(left, { taskId: 'ERITFBUWFxgZGhscHR4fIA', toDeviceId: right.deviceId });
  assert.throws(() => codec(right, left).decodeControl(wrongTask), /task/);

  const directionBound = codec(right, left);
  directionBound.encodeControl(core('stream-hello', right, left, 'receive'));
  const wrongDirection = directionBound.decodeControl(signedWire(left, {
    toDeviceId: right.deviceId,
    direction: 'receive'
  }));
  assert.strictEqual(directionBound.verifyControl(wrongDirection), false);
  const correctDirection = directionBound.decodeControl(signedWire(left, {
    toDeviceId: right.deviceId,
    direction: 'send'
  }));
  assert.strictEqual(directionBound.verifyControl(correctDirection), true);
}

function testTimeBounds() {
  const left = createDevice('8888888888888888');
  const right = createDevice('9999999999999999');
  assert.throws(
    () => createSignedStreamControlCodec({ localDevice: left, remotePeer: right, taskId: TASK_ID, ttlMs: 300001 }),
    /TTL/
  );

  const expired = signedWire(left, {
    toDeviceId: right.deviceId,
    issuedAt: NOW - 70000,
    expiresAt: NOW - 40000
  });
  assert.throws(() => codec(right, left).decodeControl(expired), /expired/);

  const stale = signedWire(left, {
    toDeviceId: right.deviceId,
    issuedAt: NOW - 400000,
    expiresAt: NOW - 100000
  });
  assert.throws(() => codec(right, left).decodeControl(stale), /expired/);

  const future = signedWire(left, {
    toDeviceId: right.deviceId,
    issuedAt: NOW + 30001,
    expiresAt: NOW + 60001
  });
  assert.throws(() => codec(right, left).decodeControl(future), /future/);

  const overlong = signedWire(left, {
    toDeviceId: right.deviceId,
    issuedAt: NOW,
    expiresAt: NOW + 300001
  });
  assert.throws(() => codec(right, left).decodeControl(overlong), /validity period/);
}

function testStrictCanonicalInput() {
  const left = createDevice('aaaaaaaaaaaaaaaa');
  const right = createDevice('bbbbbbbbbbbbbbbb');
  const receiver = codec(right, left);
  const valid = JSON.parse(codec(left, right).encodeControl(core('stream-hello', left, right, 'send')));

  const unknown = signObject(left, { ...withoutSignature(valid), unexpected: true });
  assert.throws(() => receiver.decodeControl(unknown), /unknown field/);

  const missing = withoutSignature(valid);
  delete missing.expiresAt;
  assert.throws(() => receiver.decodeControl(signObject(left, missing)), /missing expiresAt/);

  assert.throws(() => receiver.decodeControl(Buffer.from(` ${canonicalJson(valid)}`)), /canonical/);
  assert.throws(() => receiver.decodeControl(Buffer.from('{"broken":', 'utf8')), /valid JSON/);
  assert.throws(() => receiver.decodeControl(Buffer.from([0xc3, 0x28])), /UTF-8/);
  assert.throws(
    () => receiver.decodeControl(Buffer.from('{"app":"\\ud800"}', 'utf8')),
    /unpaired surrogate/
  );
  assert.throws(() => receiver.decodeControl(Buffer.alloc(16 * 1024 + 1, 0x20)), /16 KiB/);

  const paddedSignature = { ...valid, signature: `${valid.signature}==` };
  assert.throws(() => receiver.decodeControl(Buffer.from(canonicalJson(paddedSignature))), /signature/);
  const nonCancelCode = signObject(left, { ...withoutSignature(valid), code: 'timeout' });
  assert.throws(() => receiver.decodeControl(nonCancelCode), /unknown field/);
}

function testReplayAndOrdering() {
  const left = createDevice('cccccccccccccccc');
  const right = createDevice('dddddddddddddddd');
  const receiver = codec(right, left);

  assert.throws(
    () => receiver.decodeControl(signedWire(left, { toDeviceId: right.deviceId, sequence: 1 })),
    /exactly 0/
  );
  const zeroBytes = signedWire(left, { toDeviceId: right.deviceId, sequence: 0 });
  const zero = receiver.decodeControl(zeroBytes);
  assert.throws(
    () => receiver.decodeControl(signedWire(left, { toDeviceId: right.deviceId, sequence: 1 })),
    /exactly 0/,
    'decode without verification must not advance sequence state'
  );
  assert.strictEqual(receiver.verifyControl(zero), true);
  assert.throws(() => receiver.decodeControl(zeroBytes), /exactly 1/);
  assert.throws(
    () => receiver.decodeControl(signedWire(left, { toDeviceId: right.deviceId, sequence: 2 })),
    /exactly 1/
  );
  const one = receiver.decodeControl(signedWire(left, {
    command: 'stream-start',
    toDeviceId: right.deviceId,
    sequence: 1
  }));
  assert.strictEqual(receiver.verifyControl(one), true);
}

function codec(localDevice, remotePeer) {
  return createSignedStreamControlCodec({
    localDevice,
    remotePeer,
    taskId: TASK_ID,
    now: () => NOW
  });
}

function core(type, from, to, direction) {
  return {
    type,
    protocol: 1,
    taskId: TASK_ID,
    fromPeerId: from.deviceId,
    toPeerId: to.deviceId,
    direction
  };
}

function createDevice(deviceId) {
  const keys = crypto.generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
  });
  return {
    deviceId,
    signingPublicKey: keys.publicKey,
    signingPrivateKey: keys.privateKey
  };
}

function signedWire(device, overrides = {}) {
  const unsigned = {
    app: APP_ID,
    protocolVersion: PROTOCOL_VERSION,
    type: MESSAGE_TYPES.TRANSFER_STREAM_CONTROL,
    command: 'stream-hello',
    controlProtocol: 1,
    taskId: TASK_ID,
    fromDeviceId: device.deviceId,
    toDeviceId: 'ffffffffffffffff',
    direction: 'send',
    sequence: 0,
    issuedAt: NOW,
    expiresAt: NOW + 30000,
    ...overrides
  };
  if (unsigned.command === 'stream-cancel' && unsigned.code === undefined) unsigned.code = 'cancelled';
  return signObject(device, unsigned);
}

function signObject(device, unsigned) {
  const signature = crypto.sign(
    null,
    Buffer.from(canonicalJson(unsigned), 'utf8'),
    crypto.createPrivateKey(device.signingPrivateKey)
  ).toString('base64url');
  return Buffer.from(canonicalJson({ ...unsigned, signature }), 'utf8');
}

function withoutSignature(value) {
  const copy = { ...value };
  delete copy.signature;
  return copy;
}

main();

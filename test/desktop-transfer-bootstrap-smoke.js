'use strict';

const assert = require('assert');
const crypto = require('crypto');
const { Duplex } = require('stream');
const { APP_ID, MESSAGE_TYPES, PROTOCOL_VERSION } = require('../src/v2/constants');
const {
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  bootstrapOutgoingTransfer
} = require('../src/v2/desktop-transfer-bootstrap');
const { createTransferManifest, createTaskId } = require('../src/v2/transfer-manifest');
const {
  TYPE_TRANSFER_DECISION,
  TYPE_TRANSFER_MANIFEST,
  decodeTransferMessage,
  encodeTransferMessage
} = require('../src/v2/transfer-message-codec');
const {
  signTransferMessage,
  verifyTransferMessage
} = require('../src/v2/transfer-message-auth');
const { MAX_FRAME_SIZE, WireFrameDecoder, encodeWireFrame } = require('../src/v2/wire-frame');

const NOW = 1_760_000_000_000;
const TTL_MS = 30_000;
const EPHEMERAL_PUBLIC_KEY = Buffer.alloc(32, 0x5a).toString('base64url');
const SESSION_ID = Buffer.from('bootstrap-test-1').toString('base64url');
const OTHER_SESSION_ID = Buffer.from('bootstrap-test-2').toString('base64url');

async function main() {
  await testTimeoutConfiguration();
  await testAcceptedAndCleanHandoff();
  await testAcceptedDecisionPreservesCoalescedStreamBytes();
  await testRejectedDecisionReturnsNormally();
  await testTamperedSignatureFailsClosed();
  await testWrongPeerTaskAndRouteFailClosed();
  await testTimeoutFailsClosedAndCleansListeners();
  await testMalformedAndExtraFramesFailClosed();
  console.log('desktop transfer bootstrap smoke tests passed');
}

async function testAcceptedAndCleanHandoff() {
  const fixture = createFixture();
  const baseline = listenerSnapshot(fixture.client);
  const requestPromise = readOneFrame(fixture.server);
  const bootstrap = bootstrapOutgoingTransfer(options(fixture));

  const request = await requestPromise;
  assert.strictEqual(request.header.type, MESSAGE_TYPES.TRANSFER_MANIFEST);
  const signedManifest = decodeTransferMessage(TYPE_TRANSFER_MANIFEST, request.payload, { now: NOW });
  assert.strictEqual(
    verifyTransferMessage(
      TYPE_TRANSFER_MANIFEST,
      signedManifest,
      fixture.local.signingPublicKey,
      { now: NOW }
    ),
    true
  );
  assert.strictEqual(signedManifest.manifest.taskId, fixture.manifest.taskId);
  assert.strictEqual(signedManifest.senderEphemeralPublicKey, EPHEMERAL_PUBLIC_KEY);
  assert.strictEqual(signedManifest.sessionId, SESSION_ID);
  assert.strictEqual(signedManifest.senderDeviceId, fixture.local.deviceId);
  assert.strictEqual(signedManifest.receiverDeviceId, fixture.remote.deviceId);

  writeFragments(fixture.server, decisionFrame(fixture, { decision: 'accepted' }), [3, 19]);
  const decision = await bootstrap;
  assert.strictEqual(decision.decision, 'accepted');
  assert.strictEqual(decision.taskId, fixture.manifest.taskId);
  assert.strictEqual(decision.sessionId, SESSION_ID);
  assert.strictEqual(fixture.client.isPaused(), true);
  assert.deepStrictEqual(listenerSnapshot(fixture.client), baseline);

  const nextBytes = Buffer.from('next-session-bytes');
  const received = onceData(fixture.client);
  fixture.server.write(nextBytes);
  fixture.client.resume();
  assert.deepStrictEqual(await received, nextBytes);
  destroyFixture(fixture);
}

async function testRejectedDecisionReturnsNormally() {
  const fixture = createFixture();
  const requestPromise = readOneFrame(fixture.server);
  const bootstrap = bootstrapOutgoingTransfer({
    ...options(fixture),
    remotePeer: fixture.remote
  });
  await requestPromise;
  fixture.server.write(decisionFrame(fixture, { decision: 'rejected' }));

  const decision = await bootstrap;
  assert.strictEqual(decision.decision, 'rejected');
  assert.strictEqual(fixture.client.destroyed, false);
  assert.strictEqual(fixture.client.isPaused(), true);
  destroyFixture(fixture);
}

async function testAcceptedDecisionPreservesCoalescedStreamBytes() {
  const fixture = createFixture();
  const requestPromise = readOneFrame(fixture.server);
  const bootstrap = bootstrapOutgoingTransfer(options(fixture));
  await requestPromise;

  const streamBytes = Buffer.from('NTV2MUX1-next-session');
  fixture.server.write(Buffer.concat([
    decisionFrame(fixture, { decision: 'accepted' }),
    streamBytes
  ]));
  const decision = await bootstrap;
  assert.strictEqual(decision.decision, 'accepted');
  assert.strictEqual(fixture.client.isPaused(), true);

  const received = onceData(fixture.client);
  fixture.client.resume();
  assert.deepStrictEqual(await received, streamBytes);
  destroyFixture(fixture);
}

async function testTamperedSignatureFailsClosed() {
  const fixture = createFixture();
  const requestPromise = readOneFrame(fixture.server);
  const bootstrap = bootstrapOutgoingTransfer(options(fixture));
  await requestPromise;

  const signed = signedDecision(fixture, { decision: 'accepted' });
  fixture.server.write(wireDecision({ ...signed, decision: 'rejected' }));
  await assert.rejects(bootstrap, /signature verification failed/i);
  await waitForDestroyed(fixture.client);
  destroyFixture(fixture);
}

async function testWrongPeerTaskAndRouteFailClosed() {
  const cases = [
    {
      name: 'wrong peer key',
      makeDecision(fixture) {
        const stranger = createIdentity('5555555555555555');
        return signedDecision(fixture, {}, stranger.signingPrivateKey);
      },
      pattern: /signature verification failed/i
    },
    {
      name: 'wrong task',
      makeDecision(fixture) {
        return signedDecision(fixture, { taskId: createTaskId() });
      },
      pattern: /task does not match/i
    },
    {
      name: 'wrong route',
      makeDecision(fixture) {
        return signedDecision(fixture, { receiverDeviceId: '4444444444444444' });
      },
      pattern: /route does not match/i
    },
    {
      name: 'wrong session',
      makeDecision(fixture) {
        return signedDecision(fixture, { sessionId: OTHER_SESSION_ID });
      },
      pattern: /session does not match/i
    }
  ];

  for (const testCase of cases) {
    const fixture = createFixture();
    const requestPromise = readOneFrame(fixture.server);
    const bootstrap = bootstrapOutgoingTransfer(options(fixture));
    await requestPromise;
    fixture.server.write(wireDecision(testCase.makeDecision(fixture)));
    await assert.rejects(bootstrap, testCase.pattern, testCase.name);
    await waitForDestroyed(fixture.client);
    destroyFixture(fixture);
  }
}

async function testTimeoutConfiguration() {
  assert.strictEqual(DEFAULT_TIMEOUT_MS, 90_000);
  assert.strictEqual(MAX_TIMEOUT_MS, 10 * 60_000);

  const fixture = createFixture();
  const requestPromise = readOneFrame(fixture.server);
  const bootstrap = bootstrapOutgoingTransfer({
    ...options(fixture),
    timeoutMs: MAX_TIMEOUT_MS
  });
  await requestPromise;
  fixture.server.write(decisionFrame(fixture, { decision: 'rejected' }));
  assert.strictEqual((await bootstrap).decision, 'rejected');
  destroyFixture(fixture);

  const invalid = createFixture();
  assert.throws(
    () => bootstrapOutgoingTransfer({ ...options(invalid), timeoutMs: MAX_TIMEOUT_MS + 1 }),
    /timeout/
  );
  destroyFixture(invalid);

  const missingSession = createFixture();
  const missingOptions = options(missingSession);
  delete missingOptions.sessionId;
  assert.throws(() => bootstrapOutgoingTransfer(missingOptions), /missing sessionId/);
  destroyFixture(missingSession);

  const paddedSession = createFixture();
  assert.throws(
    () => bootstrapOutgoingTransfer({ ...options(paddedSession), sessionId: `${SESSION_ID}=` }),
    /session ID/i
  );
  destroyFixture(paddedSession);
}

async function testTimeoutFailsClosedAndCleansListeners() {
  const fixture = createFixture();
  const baseline = listenerSnapshot(fixture.client);
  const requestPromise = readOneFrame(fixture.server);
  const bootstrap = bootstrapOutgoingTransfer({ ...options(fixture), timeoutMs: 25 });
  await requestPromise;

  await assert.rejects(bootstrap, /timed out/i);
  await waitForDestroyed(fixture.client);
  assert.deepStrictEqual(listenerSnapshot(fixture.client), baseline);
  destroyFixture(fixture);
}

async function testMalformedAndExtraFramesFailClosed() {
  const malformed = createFixture();
  const malformedRequest = readOneFrame(malformed.server);
  const malformedBootstrap = bootstrapOutgoingTransfer(options(malformed));
  await malformedRequest;
  malformed.server.write(encodeWireFrame({
    header: protocolHeader(MESSAGE_TYPES.TRANSFER_DECISION),
    payload: Buffer.from('{}')
  }));
  await assert.rejects(malformedBootstrap, /missing|required|payload/i);
  await waitForDestroyed(malformed.client);
  destroyFixture(malformed);

  const oversized = createFixture();
  const oversizedRequest = readOneFrame(oversized.server);
  const oversizedBootstrap = bootstrapOutgoingTransfer(options(oversized));
  await oversizedRequest;
  const oversizedPrefix = Buffer.alloc(4);
  oversizedPrefix.writeUInt32BE(MAX_FRAME_SIZE + 1);
  oversized.server.write(oversizedPrefix);
  await assert.rejects(oversizedBootstrap, /frame length/i);
  await waitForDestroyed(oversized.client);
  destroyFixture(oversized);

  const extra = createFixture();
  const extraRequest = readOneFrame(extra.server);
  const extraBootstrap = bootstrapOutgoingTransfer(options(extra));
  await extraRequest;
  const rejected = decisionFrame(extra, { decision: 'rejected' });
  const second = decisionFrame(extra, { decision: 'rejected' });
  extra.server.write(Buffer.concat([rejected, second]));
  await assert.rejects(extraBootstrap, /unexpected bytes/i);
  await waitForDestroyed(extra.client);
  destroyFixture(extra);
}

function options(fixture) {
  return {
    stream: fixture.client,
    localDevice: fixture.local,
    remotePeer: { identity: fixture.remote },
    manifest: fixture.manifest,
    senderEphemeralPublicKey: EPHEMERAL_PUBLIC_KEY,
    sessionId: fixture.sessionId,
    clock: () => NOW,
    ttlMs: TTL_MS,
    timeoutMs: 500
  };
}

function createFixture() {
  const [client, server] = createDuplexPair();
  return {
    client,
    server,
    local: createIdentity('1111111111111111'),
    remote: createIdentity('2222222222222222'),
    sessionId: SESSION_ID,
    manifest: createTransferManifest({
      entries: [{
        kind: 'file',
        path: 'hello.txt',
        size: 5,
        sha256: crypto.createHash('sha256').update('hello').digest('hex')
      }]
    })
  };
}

function createIdentity(deviceId) {
  const keys = crypto.generateKeyPairSync('ed25519');
  return {
    deviceId,
    signingPrivateKey: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    signingPublicKey: keys.publicKey.export({ type: 'spki', format: 'pem' })
  };
}

function signedDecision(fixture, overrides = {}, signingPrivateKey = fixture.remote.signingPrivateKey) {
  return signTransferMessage(TYPE_TRANSFER_DECISION, {
    app: APP_ID,
    protocolVersion: PROTOCOL_VERSION,
    type: TYPE_TRANSFER_DECISION,
    taskId: fixture.manifest.taskId,
    senderDeviceId: fixture.remote.deviceId,
    receiverDeviceId: fixture.local.deviceId,
    decision: 'accepted',
    sessionId: fixture.sessionId,
    issuedAt: NOW,
    expiresAt: NOW + TTL_MS,
    ...overrides
  }, signingPrivateKey, { now: NOW });
}

function decisionFrame(fixture, overrides = {}) {
  return wireDecision(signedDecision(fixture, overrides));
}

function wireDecision(decision) {
  return encodeWireFrame({
    header: protocolHeader(MESSAGE_TYPES.TRANSFER_DECISION),
    payload: encodeTransferMessage(TYPE_TRANSFER_DECISION, decision, { now: NOW })
  });
}

function protocolHeader(type) {
  return { app: APP_ID, protocolVersion: PROTOCOL_VERSION, type };
}

function createDuplexPair() {
  let left;
  let right;
  left = createEndpoint(() => right);
  right = createEndpoint(() => left);
  return [left, right];
}

function createEndpoint(peer) {
  return new Duplex({
    read() {},
    write(chunk, _encoding, callback) {
      const target = peer();
      if (!target || target.destroyed) {
        callback(new Error('Peer stream is closed'));
        return;
      }
      target.push(Buffer.from(chunk));
      callback();
    },
    final(callback) {
      const target = peer();
      if (target && !target.destroyed) target.push(null);
      callback();
    }
  });
}

function readOneFrame(stream) {
  return new Promise((resolve, reject) => {
    const decoder = new WireFrameDecoder();

    function cleanup() {
      stream.removeListener('data', onData);
      stream.removeListener('error', onError);
      stream.removeListener('end', onEnd);
    }

    function onData(chunk) {
      try {
        const frames = decoder.push(chunk);
        if (frames.length !== 1 || decoder.bufferedBytes !== 0) {
          throw new Error('Expected exactly one bootstrap request frame');
        }
        cleanup();
        stream.pause();
        resolve(frames[0]);
      } catch (error) {
        cleanup();
        reject(error);
      }
    }

    function onError(error) {
      cleanup();
      reject(error);
    }

    function onEnd() {
      cleanup();
      reject(new Error('Bootstrap request stream ended early'));
    }

    stream.on('data', onData);
    stream.once('error', onError);
    stream.once('end', onEnd);
    stream.resume();
  });
}

function onceData(stream) {
  return new Promise((resolve, reject) => {
    stream.once('data', resolve);
    stream.once('error', reject);
  });
}

function writeFragments(stream, bytes, splitPoints) {
  let offset = 0;
  for (const end of [...splitPoints, bytes.length]) {
    stream.write(bytes.subarray(offset, end));
    offset = end;
  }
}

function listenerSnapshot(stream) {
  return {
    readable: stream.listenerCount('readable'),
    end: stream.listenerCount('end'),
    close: stream.listenerCount('close'),
    error: stream.listenerCount('error')
  };
}

function waitForDestroyed(stream) {
  if (stream.destroyed) return Promise.resolve();
  return new Promise((resolve) => stream.once('close', resolve));
}

function destroyFixture(fixture) {
  fixture.client.destroy();
  fixture.server.destroy();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

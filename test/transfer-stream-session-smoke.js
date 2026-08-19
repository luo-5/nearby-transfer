'use strict';

const assert = require('assert');
const { Duplex } = require('stream');
const { canonicalJson } = require('../src/v2/canonical-json');
const { APP_ID, MESSAGE_TYPES, PROTOCOL_VERSION } = require('../src/v2/constants');
const { createTaskId } = require('../src/v2/transfer-manifest');
const { decodeWireFrame, encodeWireFrame } = require('../src/v2/wire-frame');
const {
  CONTROL_TYPES,
  FRAME_KIND_CHUNK,
  FRAME_KIND_CONTROL,
  MUX_PREFIX_BYTES,
  StreamEnvelopeDecoder,
  createTransferStreamSession,
  encodeStreamEnvelope
} = require('../src/v2/transfer-stream-session');
const { encodeFrame: encodeChunkFrame } = require('../src/v2/transfer-chunk-frame');

const PEER_A = 'desktop-peer-a';
const PEER_B = 'desktop-peer-b';

async function main() {
  await testNormalFragmentedMultiFileFlow();
  await testReverseDirectionFlow();
  await testMultipleFramesInOnePacket();
  await testBackpressureAndSerializedWrites();
  await testStartPauseRaceBeforeWriteCallback();
  await testReceiverDrivenPauseAndResume();
  await testSenderDrivenPauseAndResume();
  await testLatePauseWhileAwaitingAcknowledgement();
  await testPausedSessionSuspendsIdleTimeout();
  await testPauseLeaseExpires();
  await testCancellationWhilePaused();
  await testCancellationAndCleanup();
  await testPendingHooksAndCleanupSettleBoundedly();
  await testHandshakeTimeoutAndCleanup();
  await testTruncatedEof();
  await testWriterAuthenticationFailure();
  await testWriterCompletionFailure();
  await testWriterMustConfirmAtomicPublication();
  await testSlowCompletionAckWriteDoesNotStartClosingTimer();
  await testClosingTimeoutWithoutPeerEof();
  await testUnverifiedAndMalformedControl();
  await testUnsolicitedFlowAcknowledgement();
  await testOutOfOrderChunk();
  await testCrossTaskInjection();
  await testDataAfterCompletion();
  await testBoundedMuxHeader();
  console.log('transfer stream session smoke tests passed');
}

async function testNormalFragmentedMultiFileFlow() {
  const taskId = createTaskId();
  const chunks = [
    chunk(taskId, 'folder/alpha.txt', 0, 0, Buffer.from('abc')),
    chunk(taskId, 'folder/alpha.txt', 3, 1, Buffer.from('de')),
    chunk(taskId, 'beta.bin', 0, 2, Buffer.from([1, 2, 3, 4])),
    chunk(taskId, 'empty.txt', 0, 3, Buffer.alloc(0))
  ];
  const readerTracker = { returned: 0 };
  const writer = createRecordingWriter();
  const pair = createMemoryPair({ fragmentSize: 1 });
  const sessions = createSessionPair(pair, taskId, makeReader(chunks, readerTracker), writer);
  const [sent, received] = await Promise.all([sessions.sender.start(), sessions.receiver.start()]);

  assert.strictEqual(sent.state, 'completed');
  assert.strictEqual(received.state, 'completed');
  assert.strictEqual(sent.chunks, chunks.length);
  assert.strictEqual(received.chunks, chunks.length);
  assert.deepStrictEqual(writer.received.map(publicChunk), chunks.map(publicChunk));
  assert.strictEqual(writer.completed, 1);
  assert.strictEqual(writer.cancelled, 0);
  assert.strictEqual(readerTracker.returned, 1);
  assertNoSessionListeners(pair.left);
  assertNoSessionListeners(pair.right);
  assert.ok(!JSON.stringify(sent).includes('sourcePath'));
}


async function testReverseDirectionFlow() {
  const taskId = createTaskId();
  const chunks = [
    chunk(taskId, 'reverse/one.txt', 0, 0, Buffer.from('one')),
    chunk(taskId, 'reverse/two.txt', 0, 1, Buffer.from('two'))
  ];
  const writer = createRecordingWriter();
  const pair = createMemoryPair({ fragmentSize: 3 });
  const sender = createTransferStreamSession({
    ...baseConfig('sender', pair.right, taskId, PEER_B, PEER_A),
    chunkReader: makeReader(chunks, { returned: 0 })
  });
  const receiver = createTransferStreamSession({
    ...baseConfig('receiver', pair.left, taskId, PEER_A, PEER_B),
    chunkWriter: writer
  });

  const [sent, received] = await Promise.all([sender.start(), receiver.start()]);
  assert.strictEqual(sent.state, 'completed');
  assert.strictEqual(received.state, 'completed');
  assert.deepStrictEqual(writer.received.map(publicChunk), chunks.map(publicChunk));
}

async function testMultipleFramesInOnePacket() {
  const decoder = new StreamEnvelopeDecoder();
  const seen = [];
  const first = encodeStreamEnvelope(FRAME_KIND_CONTROL, Buffer.from('first'));
  const second = encodeStreamEnvelope(FRAME_KIND_CHUNK, Buffer.from('second'));
  await decoder.push(Buffer.concat([first, second]), async (kind, payload) => {
    seen.push([kind, payload.toString('utf8')]);
  });
  decoder.finish();
  assert.deepStrictEqual(seen, [
    [FRAME_KIND_CONTROL, 'first'],
    [FRAME_KIND_CHUNK, 'second']
  ]);
}

async function testBackpressureAndSerializedWrites() {
  const taskId = createTaskId();
  const chunks = Array.from({ length: 12 }, (_, sequence) =>
    chunk(taskId, 'large.bin', sequence * 64, sequence, Buffer.alloc(64, sequence)));
  const writer = createRecordingWriter({ writeDelay: 1 });
  const pair = createMemoryPair({ writableHighWaterMark: 1, writeDelay: 2 });
  const sessions = createSessionPair(pair, taskId, makeReader(chunks, { returned: 0 }), writer);
  await Promise.all([sessions.sender.start(), sessions.receiver.start()]);

  assert.ok(pair.left.backpressureCount > 0, 'sender should observe writable backpressure');
  assert.ok(pair.right.backpressureCount > 0, 'receiver should observe writable backpressure');
  assert.strictEqual(pair.left.maxConcurrentWrites, 1);
  assert.strictEqual(pair.right.maxConcurrentWrites, 1);
  assert.deepStrictEqual(writer.received.map((item) => item.sequence), chunks.map((item) => item.sequence));
}


async function testStartPauseRaceBeforeWriteCallback() {
  const taskId = createTaskId();
  const releaseReader = deferred();
  const writer = createRecordingWriter();
  const pair = createMemoryPair({ writeCallbackDelay: 40 });
  async function* delayedReader() {
    await releaseReader.promise;
    yield chunk(taskId, 'start-pause-race.bin', 0, 0, Buffer.of(1));
  }
  const sessions = createSessionPair(pair, taskId, delayedReader(), writer);
  const senderDone = sessions.sender.start();
  const receiverDone = sessions.receiver.start();

  await waitFor(() => sessions.receiver.getState().state === 'receiving');
  const paused = await sessions.receiver.pause();
  assert.strictEqual(paused.localPauseState, 'paused');
  assert.strictEqual(sessions.sender.getState().state, 'sending');
  assert.strictEqual(sessions.sender.getState().remotePaused, true);
  await sessions.receiver.resume();
  releaseReader.resolve();

  const [sent, received] = await Promise.all([senderDone, receiverDone]);
  assert.strictEqual(sent.state, 'completed');
  assert.strictEqual(received.state, 'completed');
  assert.strictEqual(writer.received.length, 1);
}

async function testReceiverDrivenPauseAndResume() {
  const taskId = createTaskId();
  const firstWrite = deferred();
  const chunks = Array.from({ length: 30 }, (_, sequence) =>
    chunk(taskId, 'receiver-pause.bin', sequence, sequence, Buffer.of(sequence)));
  const writer = createRecordingWriter({ onFirstWrite: () => firstWrite.resolve() });
  const pair = createMemoryPair({ writeDelay: 1 });
  const sessions = createSessionPair(pair, taskId, makeReader(chunks, { returned: 0 }, 2), writer);
  const senderDone = sessions.sender.start();
  const receiverDone = sessions.receiver.start();

  await firstWrite.promise;
  const paused = await sessions.receiver.pause();
  const receivedAtPause = writer.received.length;
  assert.strictEqual(paused.paused, true);
  assert.strictEqual(paused.localPauseState, 'paused');
  await waitFor(() => sessions.sender.getState().remotePaused === true);
  await sleep(30);
  assert.strictEqual(writer.received.length, receivedAtPause, 'receiver pause acknowledgement must fence later chunks');

  const resumed = await sessions.receiver.resume();
  assert.strictEqual(resumed.localPauseState, 'running');
  await Promise.all([senderDone, receiverDone]);
  assert.strictEqual(writer.received.length, chunks.length);
}

async function testSenderDrivenPauseAndResume() {
  const taskId = createTaskId();
  const firstWrite = deferred();
  const chunks = Array.from({ length: 25 }, (_, sequence) =>
    chunk(taskId, 'sender-pause.bin', sequence, sequence, Buffer.of(sequence)));
  const writer = createRecordingWriter({ onFirstWrite: () => firstWrite.resolve() });
  const pair = createMemoryPair({ writeDelay: 1 });
  const sessions = createSessionPair(pair, taskId, makeReader(chunks, { returned: 0 }, 2), writer);
  const senderDone = sessions.sender.start();
  const receiverDone = sessions.receiver.start();

  await firstWrite.promise;
  const firstPause = sessions.sender.pause();
  assert.strictEqual(sessions.sender.pause(), firstPause, 'duplicate local pause must share one acknowledgement');
  const paused = await firstPause;
  const receivedAtPause = writer.received.length;
  assert.strictEqual(paused.paused, true);
  await waitFor(() => sessions.receiver.getState().remotePaused === true);
  await sleep(30);
  assert.strictEqual(writer.received.length, receivedAtPause);

  await sessions.sender.resume();
  await Promise.all([senderDone, receiverDone]);
  assert.strictEqual(writer.received.length, chunks.length);
}


async function testLatePauseWhileAwaitingAcknowledgement() {
  const taskId = createTaskId();
  const completeGate = deferred();
  const writer = createRecordingWriter();
  writer.complete = async function complete() {
    this.completed += 1;
    await completeGate.promise;
    return { published: true };
  };
  const pair = createMemoryPair();
  const sessions = createSessionPair(pair, taskId, makeReader([], { returned: 0 }), writer);
  const senderDone = sessions.sender.start();
  const receiverDone = sessions.receiver.start();

  await waitFor(() => writer.completed === 1 && sessions.sender.getState().state === 'awaiting-ack');
  const pauseResult = settle(sessions.receiver.pause());
  await waitFor(() => pair.left.writeCount >= 4);
  assert.strictEqual(sessions.sender.getState().state, 'awaiting-ack');
  completeGate.resolve();

  const [sent, received, pause] = await Promise.all([senderDone, receiverDone, pauseResult]);
  assert.strictEqual(sent.state, 'completed');
  assert.strictEqual(received.state, 'completed');
  assert.strictEqual(pause.status, 'rejected');
  assert.match(pause.reason.message, /completed.*flow-control command/i);
}

async function testPausedSessionSuspendsIdleTimeout() {
  const taskId = createTaskId();
  const firstWrite = deferred();
  const chunks = Array.from({ length: 10 }, (_, sequence) =>
    chunk(taskId, 'long-pause.bin', sequence, sequence, Buffer.of(sequence)));
  const writer = createRecordingWriter({ onFirstWrite: () => firstWrite.resolve() });
  const pair = createMemoryPair({ writeDelay: 1 });
  const common = { handshakeTimeoutMs: 1000, idleTimeoutMs: 100, writeTimeoutMs: 1000 };
  const sender = createTransferStreamSession({
    ...baseConfig('sender', pair.left, taskId, PEER_A, PEER_B),
    ...common,
    chunkReader: makeReader(chunks, { returned: 0 }, 3)
  });
  const receiver = createTransferStreamSession({
    ...baseConfig('receiver', pair.right, taskId, PEER_B, PEER_A),
    ...common,
    chunkWriter: writer
  });
  const senderDone = sender.start();
  const receiverDone = receiver.start();

  await firstWrite.promise;
  await receiver.pause();
  await sleep(300);
  assert.strictEqual(receiver.getState().state, 'receiving');
  assert.strictEqual(sender.getState().state, 'sending');
  await receiver.resume();
  await Promise.all([senderDone, receiverDone]);
  assert.strictEqual(writer.received.length, chunks.length);
}

async function testPauseLeaseExpires() {
  const fixture = await startManualReceiver({
    idleTimeoutMs: 500,
    pauseTimeoutMs: 30,
    operationTimeoutMs: 100
  });
  await writeAsync(fixture.peer, Buffer.concat([
    remoteControlEnvelope(CONTROL_TYPES.HELLO, fixture.taskId),
    remoteControlEnvelope(CONTROL_TYPES.START, fixture.taskId),
    remoteControlEnvelope(CONTROL_TYPES.PAUSE, fixture.taskId)
  ]));

  const result = await settle(fixture.done);
  assert.strictEqual(result.status, 'rejected');
  assert.strictEqual(result.reason.name, 'TimeoutError');
  assert.match(result.reason.message, /pause timed out/i);
  assert.strictEqual(fixture.session.getState().state, 'failed');
  assert.strictEqual(fixture.writer.cancelled, 1);
}

async function testCancellationWhilePaused() {
  const taskId = createTaskId();
  const firstWrite = deferred();
  const tracker = { returned: 0 };
  const chunks = Array.from({ length: 50 }, (_, sequence) =>
    chunk(taskId, 'paused-cancel.bin', sequence, sequence, Buffer.of(sequence)));
  const writer = createRecordingWriter({ onFirstWrite: () => firstWrite.resolve() });
  const pair = createMemoryPair({ writeDelay: 1 });
  const sessions = createSessionPair(pair, taskId, makeReader(chunks, tracker, 3), writer);
  const senderDone = sessions.sender.start();
  const receiverDone = sessions.receiver.start();

  await firstWrite.promise;
  await sessions.receiver.pause();
  await assert.rejects(sessions.receiver.cancel('cancel while paused'), /cancelled/i);
  await Promise.all([settle(senderDone), settle(receiverDone)]);
  assert.strictEqual(writer.cancelled, 1);
  assert.strictEqual(tracker.returned, 1);
  await waitFor(() => hasNoSessionListeners(pair.left) && hasNoSessionListeners(pair.right));
  assertNoSessionListeners(pair.left);
  assertNoSessionListeners(pair.right);
}

async function testCancellationAndCleanup() {
  const taskId = createTaskId();
  const readerTracker = { returned: 0 };
  const firstWrite = deferred();
  const writer = createRecordingWriter({ onFirstWrite: () => firstWrite.resolve() });
  const chunks = Array.from({ length: 50 }, (_, sequence) =>
    chunk(taskId, 'cancel.bin', sequence, sequence, Buffer.of(sequence & 0xff)));
  const pair = createMemoryPair({ writeDelay: 2 });
  const sessions = createSessionPair(pair, taskId, makeReader(chunks, readerTracker, 2), writer);
  const senderDone = sessions.sender.start();
  const receiverDone = sessions.receiver.start();
  await firstWrite.promise;
  await assert.rejects(sessions.sender.cancel('user requested cancellation'), /cancelled/i);
  const receiverResult = await settle(receiverDone);
  await settle(senderDone);

  assert.strictEqual(sessions.sender.getState().state, 'cancelled');
  assert.strictEqual(receiverResult.status, 'rejected');
  assert.strictEqual(writer.cancelled, 1);
  assert.strictEqual(readerTracker.returned, 1);
  await waitFor(() => hasNoSessionListeners(pair.left) && hasNoSessionListeners(pair.right));
  assertNoSessionListeners(pair.left);
  assertNoSessionListeners(pair.right);
}

async function testPendingHooksAndCleanupSettleBoundedly() {
  const taskId = createTaskId();
  const pair = createMemoryPair();
  pair.right.resume();
  const never = new Promise(() => {});
  let cancelEncodeCalled = false;
  const writer = createRecordingWriter();
  writer.cancel = async function cancel() {
    this.cancelled += 1;
    return never;
  };
  const session = createTransferStreamSession({
    ...baseConfig('receiver', pair.left, taskId, PEER_B, PEER_A),
    chunkWriter: writer,
    decodeControl: async () => never,
    encodeControl: async (message) => {
      if (message.type === CONTROL_TYPES.CANCEL) {
        cancelEncodeCalled = true;
        return never;
      }
      return encodeControl(message);
    },
    handshakeTimeoutMs: 500,
    operationTimeoutMs: 80
  });
  const done = session.start();
  await waitFor(() => pair.left.writeCount > 0);
  await writeAsync(pair.right, remoteControlEnvelope(CONTROL_TYPES.HELLO, taskId));

  const result = await settle(done);
  assert.strictEqual(result.status, 'rejected');
  assert.strictEqual(result.reason.name, 'TimeoutError');
  assert.match(result.reason.message, /control decoding timed out/i);
  assert.strictEqual(session.getState().state, 'failed');
  assert.strictEqual(writer.cancelled, 1);
  await waitFor(() => cancelEncodeCalled);
  assert.strictEqual(pair.left.destroyed, false, 'pending cleanup must continue after done settles');
  assertNoSessionListeners(pair.left);
  await waitFor(() => pair.left.destroyed, 500);
}

async function testHandshakeTimeoutAndCleanup() {
  const taskId = createTaskId();
  const pair = createMemoryPair();
  pair.right.resume();
  const reader = createManualReader();
  const session = createTransferStreamSession({
    ...baseConfig('sender', pair.left, taskId, PEER_A, PEER_B),
    chunkReader: reader,
    handshakeTimeoutMs: 25,
    idleTimeoutMs: 100
  });

  await assert.rejects(session.start(), (error) => error && error.name === 'TimeoutError');
  assert.strictEqual(reader.returned, 1);
  assert.strictEqual(session.getState().state, 'failed');
  await waitFor(() => hasNoSessionListeners(pair.left));
  assertNoSessionListeners(pair.left);
}

async function testTruncatedEof() {
  const fixture = await startManualReceiver();
  await writeAsync(fixture.peer, remoteControlEnvelope(CONTROL_TYPES.HELLO, fixture.taskId));
  await waitFor(() => fixture.session.getState().state === 'awaiting-start');
  const valid = remoteControlEnvelope(CONTROL_TYPES.START, fixture.taskId);
  await writeAsync(fixture.peer, valid.subarray(0, MUX_PREFIX_BYTES + 3));
  fixture.peer.end();

  const result = await settle(fixture.done);
  assert.strictEqual(result.status, 'rejected');
  assert.match(result.reason.message, /truncated|before protocol completion/i);
  assert.strictEqual(fixture.writer.cancelled, 1);
}

async function testWriterAuthenticationFailure() {
  const taskId = createTaskId();
  const readerTracker = { returned: 0 };
  const writer = createRecordingWriter({ writeError: new Error('authentication failed') });
  const pair = createMemoryPair();
  const sessions = createSessionPair(
    pair,
    taskId,
    makeReader([chunk(taskId, 'secret.bin', 0, 0, Buffer.from('secret'))], readerTracker),
    writer
  );
  const results = await Promise.all([settle(sessions.sender.start()), settle(sessions.receiver.start())]);

  assert.ok(results.every((item) => item.status === 'rejected'));
  assert.match(results[1].reason.message, /authentication failed/i);
  assert.strictEqual(writer.completed, 0);
  assert.strictEqual(writer.cancelled, 1);
  assert.strictEqual(readerTracker.returned, 1);
}


async function testWriterCompletionFailure() {
  const taskId = createTaskId();
  const tracker = { returned: 0 };
  const writer = createRecordingWriter({ completeError: new Error('publish verification failed') });
  const pair = createMemoryPair();
  const sessions = createSessionPair(pair, taskId, makeReader([
    chunk(taskId, 'publish.bin', 0, 0, Buffer.from('data'))
  ], tracker), writer);
  const results = await Promise.all([settle(sessions.sender.start()), settle(sessions.receiver.start())]);

  assert.ok(results.every((item) => item.status === 'rejected'));
  assert.match(results[1].reason.message, /publish verification failed/i);
  assert.strictEqual(writer.completed, 1);
  assert.strictEqual(writer.cancelled, 1);
  assert.strictEqual(tracker.returned, 1);
}

async function testWriterMustConfirmAtomicPublication() {
  const taskId = createTaskId();
  const tracker = { returned: 0 };
  const writer = createRecordingWriter({ completeResult: undefined });
  const pair = createMemoryPair();
  const sessions = createSessionPair(pair, taskId, makeReader([
    chunk(taskId, 'unconfirmed.bin', 0, 0, Buffer.from('data'))
  ], tracker), writer);
  const results = await Promise.all([settle(sessions.sender.start()), settle(sessions.receiver.start())]);

  assert.ok(results.every((item) => item.status === 'rejected'));
  assert.match(results[1].reason.message, /confirm atomic publication/i);
  assert.strictEqual(writer.completed, 1);
  assert.strictEqual(writer.cancelled, 1);
}

async function testSlowCompletionAckWriteDoesNotStartClosingTimer() {
  const taskId = createTaskId();
  const writer = createRecordingWriter();
  const pair = createMemoryPair();
  pair.right.writeDelayFor = (writeCount) => writeCount === 2 ? 80 : 0;
  const common = {
    idleTimeoutMs: 500,
    writeTimeoutMs: 500,
    operationTimeoutMs: 500,
    closingTimeoutMs: 25
  };
  const sender = createTransferStreamSession({
    ...baseConfig('sender', pair.left, taskId, PEER_A, PEER_B),
    ...common,
    chunkReader: makeReader([], { returned: 0 })
  });
  const receiver = createTransferStreamSession({
    ...baseConfig('receiver', pair.right, taskId, PEER_B, PEER_A),
    ...common,
    chunkWriter: writer
  });
  const startedAt = Date.now();

  const [sent, received] = await Promise.all([sender.start(), receiver.start()]);
  const elapsed = Date.now() - startedAt;
  assert.strictEqual(pair.right.writeCount, 2, 'receiver should write HELLO and COMPLETE_ACK');
  assert.ok(elapsed >= 70, 'the delayed COMPLETE_ACK write must exceed closingTimeoutMs');
  assert.strictEqual(sent.state, 'completed');
  assert.strictEqual(received.state, 'completed');
  assert.strictEqual(writer.completed, 1);
  assert.strictEqual(writer.cancelled, 0);
}

async function testClosingTimeoutWithoutPeerEof() {
  const fixture = await startManualReceiver({
    idleTimeoutMs: 500,
    closingTimeoutMs: 30,
    operationTimeoutMs: 100
  });
  await writeAsync(fixture.peer, Buffer.concat([
    remoteControlEnvelope(CONTROL_TYPES.HELLO, fixture.taskId),
    remoteControlEnvelope(CONTROL_TYPES.START, fixture.taskId),
    remoteControlEnvelope(CONTROL_TYPES.COMPLETE, fixture.taskId)
  ]));

  const result = await settle(fixture.done);
  assert.strictEqual(result.status, 'rejected');
  assert.strictEqual(result.reason.name, 'TimeoutError');
  assert.match(result.reason.message, /closing timed out/i);
  assert.strictEqual(fixture.session.getState().state, 'failed');
  assert.strictEqual(fixture.writer.completed, 1);
  assert.strictEqual(fixture.writer.cancelled, 0);
}

async function testUnverifiedAndMalformedControl() {
  const unverified = await startManualReceiver({ verifyControl: async () => false });
  await writeAsync(unverified.peer, remoteControlEnvelope(CONTROL_TYPES.HELLO, unverified.taskId));
  const unverifiedResult = await settle(unverified.done);
  assert.strictEqual(unverifiedResult.status, 'rejected');
  assert.match(unverifiedResult.reason.message, /verification failed/i);
  assert.strictEqual(unverified.writer.cancelled, 1);

  const malformed = await startManualReceiver();
  await writeAsync(malformed.peer, remoteControlEnvelope(CONTROL_TYPES.HELLO, malformed.taskId, { unexpected: true }));
  const malformedResult = await settle(malformed.done);
  assert.strictEqual(malformedResult.status, 'rejected');
  assert.match(malformedResult.reason.message, /unknown field/i);
  assert.strictEqual(malformed.writer.cancelled, 1);
}

async function testUnsolicitedFlowAcknowledgement() {
  const fixture = await startManualReceiver();
  await writeAsync(fixture.peer, Buffer.concat([
    remoteControlEnvelope(CONTROL_TYPES.HELLO, fixture.taskId),
    remoteControlEnvelope(CONTROL_TYPES.START, fixture.taskId),
    remoteControlEnvelope(CONTROL_TYPES.PAUSED, fixture.taskId)
  ]));
  const result = await settle(fixture.done);
  assert.strictEqual(result.status, 'rejected');
  assert.match(result.reason.message, /unsolicited|duplicated/i);
  assert.strictEqual(fixture.writer.cancelled, 1);
}

async function testOutOfOrderChunk() {
  const fixture = await startManualReceiver();
  await writeAsync(fixture.peer, remoteChunkEnvelope(chunk(fixture.taskId, 'early.bin', 0, 0, Buffer.of(1))));
  const result = await settle(fixture.done);
  assert.strictEqual(result.status, 'rejected');
  assert.match(result.reason.message, /out of order|authenticated hello/i);
  assert.strictEqual(fixture.writer.received.length, 0);
  assert.strictEqual(fixture.writer.cancelled, 1);
}

async function testCrossTaskInjection() {
  const fixture = await startManualReceiver();
  const frames = Buffer.concat([
    remoteControlEnvelope(CONTROL_TYPES.HELLO, fixture.taskId),
    remoteControlEnvelope(CONTROL_TYPES.START, fixture.taskId),
    remoteChunkEnvelope(chunk(createTaskId(), 'injected.bin', 0, 0, Buffer.of(1)))
  ]);
  await writeAsync(fixture.peer, frames);
  const result = await settle(fixture.done);
  assert.strictEqual(result.status, 'rejected');
  assert.match(result.reason.message, /taskId/i);
  assert.strictEqual(fixture.writer.received.length, 0);
  assert.strictEqual(fixture.writer.cancelled, 1);
}

async function testDataAfterCompletion() {
  const fixture = await startManualReceiver();
  const frames = Buffer.concat([
    remoteControlEnvelope(CONTROL_TYPES.HELLO, fixture.taskId),
    remoteControlEnvelope(CONTROL_TYPES.START, fixture.taskId),
    remoteControlEnvelope(CONTROL_TYPES.COMPLETE, fixture.taskId),
    remoteChunkEnvelope(chunk(fixture.taskId, 'late.bin', 0, 0, Buffer.of(7)))
  ]);
  await writeAsync(fixture.peer, frames);
  const result = await settle(fixture.done);
  assert.strictEqual(result.status, 'rejected');
  assert.match(result.reason.message, /out of order.*closing|after transfer completion/i);
  assert.strictEqual(fixture.writer.completed, 1);
  assert.strictEqual(fixture.writer.received.length, 0);
}

async function testBoundedMuxHeader() {
  assert.throws(() => encodeStreamEnvelope(99, Buffer.of(1)), /kind/i);
  assert.throws(() => encodeStreamEnvelope(FRAME_KIND_CONTROL, Buffer.alloc(0)), /length/i);

  const malicious = Buffer.alloc(MUX_PREFIX_BYTES);
  Buffer.from('NTV2MUX1').copy(malicious);
  malicious.writeUInt8(1, 8);
  malicious.writeUInt8(FRAME_KIND_CHUNK, 9);
  malicious.writeUInt32BE(0xffffffff, 12);
  const decoder = new StreamEnvelopeDecoder();
  await assert.rejects(decoder.push(malicious, async () => {}), /bound/i);
}

function createSessionPair(pair, taskId, chunkReader, chunkWriter) {
  return {
    sender: createTransferStreamSession({
      ...baseConfig('sender', pair.left, taskId, PEER_A, PEER_B),
      chunkReader
    }),
    receiver: createTransferStreamSession({
      ...baseConfig('receiver', pair.right, taskId, PEER_B, PEER_A),
      chunkWriter
    })
  };
}

async function startManualReceiver(overrides = {}) {
  const taskId = createTaskId();
  const writer = createRecordingWriter();
  const pair = createMemoryPair();
  pair.right.resume();
  const session = createTransferStreamSession({
    ...baseConfig('receiver', pair.left, taskId, PEER_B, PEER_A),
    chunkWriter: writer,
    ...overrides
  });
  const done = session.start();
  await waitFor(() => pair.left.writeCount > 0);
  return { session, done, writer, peer: pair.right, taskId };
}

function baseConfig(role, stream, taskId, localPeerId, remotePeerId) {
  return {
    stream,
    role,
    taskId,
    localPeerId,
    remotePeerId,
    encodeControl,
    decodeControl,
    verifyControl: async () => true,
    handshakeTimeoutMs: 500,
    idleTimeoutMs: 500,
    writeTimeoutMs: 500,
    operationTimeoutMs: 500,
    pauseTimeoutMs: 500,
    closingTimeoutMs: 500
  };
}

async function encodeControl(message) {
  return encodeWireFrame({
    header: {
      app: APP_ID,
      protocolVersion: PROTOCOL_VERSION,
      type: MESSAGE_TYPES.LIBRARY_SESSION
    },
    payload: Buffer.from(canonicalJson(message), 'utf8')
  });
}

async function decodeControl(encoded) {
  const frame = decodeWireFrame(encoded);
  assert.strictEqual(frame.header.type, MESSAGE_TYPES.LIBRARY_SESSION);
  return JSON.parse(frame.payload.toString('utf8'));
}

function remoteControlEnvelope(type, taskId, extra = null) {
  const message = {
    type,
    protocol: 1,
    taskId,
    fromPeerId: PEER_A,
    toPeerId: PEER_B,
    direction: 'send',
    ...(extra || {})
  };
  return encodeStreamEnvelope(FRAME_KIND_CONTROL, encodeWireFrame({
    header: { app: APP_ID, protocolVersion: PROTOCOL_VERSION, type: MESSAGE_TYPES.LIBRARY_SESSION },
    payload: Buffer.from(canonicalJson(message), 'utf8')
  }));
}

function remoteChunkEnvelope(value) {
  return encodeStreamEnvelope(FRAME_KIND_CHUNK, encodeChunkFrame({
    taskId: value.taskId,
    relativePath: value.path,
    offset: value.offset,
    sequence: value.sequence,
    plainLength: value.plainLength,
    nonce: value.nonce,
    authTag: value.authTag,
    ciphertext: value.ciphertext
  }));
}

function chunk(taskId, path, offset, sequence, ciphertext) {
  return Object.freeze({
    taskId,
    path,
    offset,
    sequence,
    plainLength: ciphertext.length,
    nonce: Buffer.alloc(12, sequence + 1),
    authTag: Buffer.alloc(16, sequence + 11),
    ciphertext: Buffer.from(ciphertext)
  });
}

async function* makeReader(chunks, tracker, delay = 0) {
  try {
    for (const item of chunks) {
      if (delay) await sleep(delay);
      yield item;
    }
  } finally {
    tracker.returned += 1;
  }
}

function createManualReader() {
  return {
    returned: 0,
    async next() { return { done: false, value: null }; },
    async return() { this.returned += 1; return { done: true }; },
    [Symbol.asyncIterator]() { return this; }
  };
}

function createRecordingWriter(options = {}) {
  return {
    received: [],
    completed: 0,
    cancelled: 0,
    async writeChunk(value) {
      if (options.writeDelay) await sleep(options.writeDelay);
      if (options.writeError) throw options.writeError;
      this.received.push(copyChunk(value));
      if (this.received.length === 1 && options.onFirstWrite) options.onFirstWrite();
      return { nextSequence: value.sequence + 1 };
    },
    async complete() {
      this.completed += 1;
      if (options.completeError) throw options.completeError;
      return Object.hasOwn(options, 'completeResult') ? options.completeResult : { published: true };
    },
    async cancel() {
      this.cancelled += 1;
      return { cancelled: true };
    }
  };
}

function copyChunk(value) {
  return {
    taskId: value.taskId,
    path: value.path,
    offset: value.offset,
    sequence: value.sequence,
    plainLength: value.plainLength,
    nonce: Buffer.from(value.nonce),
    authTag: Buffer.from(value.authTag),
    ciphertext: Buffer.from(value.ciphertext)
  };
}

function publicChunk(value) {
  return {
    taskId: value.taskId,
    path: value.path,
    offset: value.offset,
    sequence: value.sequence,
    plainLength: value.plainLength,
    nonce: Buffer.from(value.nonce).toString('hex'),
    authTag: Buffer.from(value.authTag).toString('hex'),
    ciphertext: Buffer.from(value.ciphertext).toString('hex')
  };
}

class MemoryEndpoint extends Duplex {
  constructor(options) {
    super({
      allowHalfOpen: true,
      readableHighWaterMark: 1024 * 1024,
      writableHighWaterMark: options.writableHighWaterMark || 16 * 1024
    });
    this.fragmentSize = options.fragmentSize || Number.MAX_SAFE_INTEGER;
    this.writeDelay = options.writeDelay || 0;
    this.writeCallbackDelay = options.writeCallbackDelay || 0;
    this.writeDelayFor = options.writeDelayFor || null;
    this.peer = null;
    this.writeCount = 0;
    this.backpressureCount = 0;
    this.concurrentWrites = 0;
    this.maxConcurrentWrites = 0;
    this.remoteEnded = false;
  }

  write(...args) {
    const accepted = super.write(...args);
    if (!accepted) this.backpressureCount += 1;
    return accepted;
  }

  _read() {}

  _write(value, _encoding, callback) {
    this.writeCount += 1;
    this.concurrentWrites += 1;
    this.maxConcurrentWrites = Math.max(this.maxConcurrentWrites, this.concurrentWrites);
    const bytes = Buffer.from(value);
    const deliveryDelay = this.writeDelayFor ? this.writeDelayFor(this.writeCount, bytes) : this.writeDelay;
    setTimeout(() => {
      let deliveryError = null;
      try {
        if (this.peer && !this.peer.destroyed && !this.peer.remoteEnded) {
          for (let offset = 0; offset < bytes.length; offset += this.fragmentSize) {
            this.peer.push(Buffer.from(bytes.subarray(offset, offset + this.fragmentSize)));
          }
        }
      } catch (error) {
        deliveryError = error;
      }
      setTimeout(() => {
        this.concurrentWrites -= 1;
        callback(deliveryError);
      }, this.writeCallbackDelay);
    }, deliveryDelay);
  }

  _final(callback) {
    setImmediate(() => {
      if (this.peer && !this.peer.destroyed && !this.peer.remoteEnded) {
        this.peer.remoteEnded = true;
        this.peer.push(null);
      }
      callback();
    });
  }

  _destroy(error, callback) {
    if (this.peer && !this.peer.destroyed && !this.peer.remoteEnded) {
      this.peer.remoteEnded = true;
      this.peer.push(null);
    }
    callback(error);
  }
}

function createMemoryPair(options = {}) {
  const left = new MemoryEndpoint(options);
  const right = new MemoryEndpoint(options);
  left.peer = right;
  right.peer = left;
  return { left, right };
}

function writeAsync(stream, bytes) {
  return new Promise((resolve, reject) => {
    stream.write(bytes, (error) => error ? reject(error) : resolve());
  });
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function settle(promise) {
  return promise.then(
    (value) => ({ status: 'fulfilled', value }),
    (reason) => ({ status: 'rejected', reason })
  );
}

async function waitFor(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for test state');
    await sleep(2);
  }
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function hasNoSessionListeners(stream) {
  return stream.listenerCount('data') === 0 &&
    stream.listenerCount('end') === 0 &&
    stream.listenerCount('error') === 0 &&
    stream.listenerCount('close') === 0;
}

function assertNoSessionListeners(stream) {
  assert.strictEqual(stream.listenerCount('data'), 0);
  assert.strictEqual(stream.listenerCount('end'), 0);
  assert.strictEqual(stream.listenerCount('error'), 0);
  assert.strictEqual(stream.listenerCount('close'), 0);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

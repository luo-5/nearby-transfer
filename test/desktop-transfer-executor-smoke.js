'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Duplex } = require('stream');
const { APP_ID, MESSAGE_TYPES, PROTOCOL_VERSION } = require('../src/v2/constants');
const { createKeyPair, createX25519KeyPair, fingerprintFor } = require('../src/core/crypto');
const {
  DEFAULT_TIMEOUTS,
  ERROR_CODE,
  createDesktopTransferExecutor
} = require('../src/v2/desktop-transfer-executor');
const { createSignedStreamControlCodec } = require('../src/v2/signed-stream-control');
const { decryptChunk, deriveSessionKey } = require('../src/v2/transfer-session-crypto');
const { createTransferStreamSession } = require('../src/v2/transfer-stream-session');
const { createTaskId, createTransferManifest, serializeTransferManifest } = require('../src/v2/transfer-manifest');
const {
  TYPE_TRANSFER_DECISION,
  TYPE_TRANSFER_MANIFEST,
  TYPE_TRANSFER_PROGRESS,
  TYPE_TRANSFER_RESUME,
  advanceTransferControlCheckpoint,
  decodeTransferMessage,
  encodeTransferMessage
} = require('../src/v2/transfer-message-codec');
const { signTransferMessage, verifyTransferMessage } = require('../src/v2/transfer-message-auth');
const { WireFrameDecoder, encodeWireFrame } = require('../src/v2/wire-frame');

const NOW = 1760000000000;
const X25519_PUBLIC_DER_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');

async function main() {
  await testTimeoutDefaultsAndBounds();
  await testTrustAndPermissionFailures();
  await testDiscoveryFailures();
  await testRejectedManifest();
  await testSessionIdsAreFreshAndBound();
  await testAcceptedEncryptedTransferAndProgress();
  await testAbortAndCleanup();
  await testConnectAndBootstrapFailures();
  await testCheckpointMismatchFailsClosed();
  console.log('desktop transfer executor smoke tests passed');
}

async function testTimeoutDefaultsAndBounds() {
  assert.strictEqual(DEFAULT_TIMEOUTS.bootstrapMs, 90_000);
  const fixture = createFixture();
  let connections = 0;
  await assert.rejects(
    createExecutor(fixture, {
      connector: async () => {
        connections += 1;
        throw new Error('expected connection failure');
      },
      timeouts: { bootstrapMs: 10 * 60_000 }
    }),
    (error) => error.code === ERROR_CODE.CONNECT_FAILED
  );
  assert.strictEqual(connections, 1, 'the 10 minute bootstrap bound must be accepted');
  await assert.rejects(
    createExecutor(fixture, { timeouts: { bootstrapMs: 10 * 60_000 + 1 } }),
    /bootstrapMs/
  );
}

async function testTrustAndPermissionFailures() {
  const fixture = createFixture();
  let connections = 0;
  const connector = async () => { connections += 1; throw new Error('must not connect'); };

  await assert.rejects(
    createExecutor(fixture, {
      connector,
      trustedPeerStore: peerStore({ ...fixture.trustedPeer, revokedAt: NOW })
    }),
    (error) => error.code === ERROR_CODE.PEER_REVOKED && error.diagnosticCode === 'PEER_REVOKED'
  );
  await assert.rejects(
    createExecutor(fixture, {
      connector,
      trustedPeerStore: peerStore({ ...fixture.trustedPeer, permissions: { transfer: false } })
    }),
    (error) => error.code === ERROR_CODE.PEER_PERMISSION_DENIED && error.diagnosticCode === 'PEER_REVOKED'
  );
  assert.strictEqual(connections, 0, 'trust failures must happen before connecting');
}

async function testDiscoveryFailures() {
  const fixture = createFixture();
  let connections = 0;
  const connector = async () => { connections += 1; throw new Error('must not connect'); };
  await assert.rejects(
    createExecutor(fixture, { connector, lanService: { listPeers: () => [] } }),
    (error) => error.code === ERROR_CODE.PEER_OFFLINE && error.diagnosticCode === 'NETWORK_INTERRUPTED'
  );

  const impostor = { ...fixture.endpoint, signingPublicKey: createKeyPair('ed25519').publicKey };
  await assert.rejects(
    createExecutor(fixture, { connector, lanService: { listPeers: () => [impostor] } }),
    (error) => error.code === ERROR_CODE.DISCOVERY_IDENTITY_MISMATCH && error.diagnosticCode === 'PEER_REVOKED'
  );
  assert.strictEqual(connections, 0, 'discovery failures must happen before connecting');
}

async function testRejectedManifest() {
  const fixture = createFixture();
  const transport = createMemoryPair();
  const remote = startRemoteBootstrap({
    stream: transport.right,
    localDevice: fixture.localDevice,
    remoteDevice: fixture.remoteDevice,
    decision: 'busy'
  });

  await assert.rejects(
    createExecutor(fixture, { connector: async () => transport.left }),
    (error) => error.code === ERROR_CODE.MANIFEST_REJECTED &&
      error.decision === 'busy' && error.diagnosticCode === 'NETWORK_INTERRUPTED'
  );
  await remote.bootstrapDone;
  assert.strictEqual(transport.left.destroyed, true, 'a rejected manifest must close the client stream');
  transport.right.destroy();
}

async function testSessionIdsAreFreshAndBound() {
  const fixture = createFixture();
  const sessionIds = [];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const transport = createMemoryPair();
    const remote = startRemoteBootstrap({
      stream: transport.right,
      localDevice: fixture.localDevice,
      remoteDevice: fixture.remoteDevice,
      decision: 'busy'
    });
    await assert.rejects(
      createExecutor(fixture, { connector: async () => transport.left }),
      (error) => error.code === ERROR_CODE.MANIFEST_REJECTED
    );
    const envelope = await remote.bootstrapDone;
    assert.strictEqual(Buffer.from(envelope.sessionId, 'base64url').length, 16);
    assert.strictEqual(Buffer.from(envelope.sessionId, 'base64url').toString('base64url'), envelope.sessionId);
    sessionIds.push(envelope.sessionId);
    transport.right.destroy();
  }
  assert.notStrictEqual(sessionIds[0], sessionIds[1], 'each executor attempt must use a fresh session ID');
}

async function testAcceptedEncryptedTransferAndProgress() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nearby-transfer-executor-'));
  try {
    const fixture = createFixture(root, [
      { name: 'empty.txt', bytes: Buffer.alloc(0) },
      { name: 'small.bin', bytes: Buffer.from('authenticated transfer') }
    ]);
    const transport = createMemoryPair();
    const remote = startRemoteBootstrap({
      stream: transport.right,
      localDevice: fixture.localDevice,
      remoteDevice: fixture.remoteDevice,
      decision: 'accepted'
    });
    const progress = [];
    const executor = await createExecutor(fixture, {
      connector: async () => transport.left,
      commitRemoteCheckpoint: async (checkpoint, now) => {
        progress.push([checkpoint, now]);
        return checkpoint;
      }
    });

    const [senderResult, receiverResult] = await Promise.all([executor.done, remote.sessionDone]);
    assert.strictEqual(senderResult.state, 'completed');
    assert.strictEqual(receiverResult.state, 'completed');
    assert.deepStrictEqual(remote.writer.files.get('empty.txt'), Buffer.alloc(0));
    assert.deepStrictEqual(remote.writer.files.get('small.bin'), Buffer.from('authenticated transfer'));
    assert.strictEqual(progress.length, 2);
    assert.deepStrictEqual(progress.map(([checkpoint, now]) => [
      checkpoint.totalTransferred,
      checkpoint.nextSequence,
      checkpoint.files.map((file) => file.completed),
      now
    ]), [
      [0, 1, [true, false], NOW],
      [Buffer.byteLength('authenticated transfer'), 2, [true, true], NOW]
    ]);
    assert.strictEqual(remote.writer.completed, 1);
    assert.strictEqual(transport.left.destroyed, true, 'completed executor must release its stream');
    await executor.close();
    transport.right.destroy();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function testAbortAndCleanup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nearby-transfer-executor-abort-'));
  try {
    const fixture = createFixture(root, [{ name: 'blocked.bin', bytes: Buffer.alloc(64, 7) }]);
    const transport = createMemoryPair();
    const writeStarted = deferred();
    const releaseWrite = deferred();
    const remote = startRemoteBootstrap({
      stream: transport.right,
      localDevice: fixture.localDevice,
      remoteDevice: fixture.remoteDevice,
      decision: 'accepted',
      onWriteChunk: async () => {
        writeStarted.resolve();
        await releaseWrite.promise;
      }
    });
    const executor = await createExecutor(fixture, { connector: async () => transport.left });
    const senderDone = settle(executor.done);
    await writeStarted.promise;
    await executor.cancel(new Error('test cancellation'));
    releaseWrite.resolve();
    const result = await senderDone;
    assert.strictEqual(result.status, 'rejected');
    assert.strictEqual(result.reason.name, 'AbortError');
    assert.strictEqual(transport.left.destroyed, true);
    await settle(remote.sessionDone);
    transport.right.destroy();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function testConnectAndBootstrapFailures() {
  const fixture = createFixture();
  await assert.rejects(
    createExecutor(fixture, { connector: async () => { throw new Error('ECONNREFUSED'); } }),
    (error) => error.code === ERROR_CODE.CONNECT_FAILED && error.diagnosticCode === 'NETWORK_INTERRUPTED'
  );

  const transport = createMemoryPair();
  await assert.rejects(
    createExecutor(fixture, {
      connector: async () => transport.left,
      timeouts: { bootstrapMs: 20 }
    }),
    (error) => error.code === ERROR_CODE.CONNECT_FAILED && error.diagnosticCode === 'NETWORK_INTERRUPTED'
  );
  assert.strictEqual(transport.left.destroyed, true, 'bootstrap failure must close its stream');
  transport.right.destroy();

  const abortedTransport = createMemoryPair();
  const controller = new AbortController();
  const pending = createExecutor(fixture, {
    connector: async () => abortedTransport.left,
    controller,
    timeouts: { bootstrapMs: 1000 }
  });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort(new Error('abort bootstrap setup'));
  await assert.rejects(pending, (error) => error.name === 'AbortError' && error.code === 'ABORT_ERR');
  assert.strictEqual(abortedTransport.left.destroyed, true, 'setup abort must close the connected stream immediately');
  abortedTransport.right.destroy();
}

async function testCheckpointMismatchFailsClosed() {
  const fixture = createFixture();
  fixture.job.progress.transferredBytes = 1;
  let connections = 0;
  await assert.rejects(
    createExecutor(fixture, { connector: async () => { connections += 1; } }),
    /checkpoint.*job progress|job progress.*checkpoint/i
  );
  assert.strictEqual(connections, 0, 'inconsistent persisted progress must fail before connecting');
}

function createExecutor(fixture, overrides = {}) {
  const controller = overrides.controller || new AbortController();
  return createDesktopTransferExecutor({
    job: fixture.job,
    checkpoint: overrides.checkpoint || fixture.checkpoint,
    signal: controller.signal,
    commitRemoteCheckpoint: overrides.commitRemoteCheckpoint || ((checkpoint) => checkpoint),
    localDevice: fixture.localDevice,
    trustedPeerStore: overrides.trustedPeerStore || peerStore(fixture.trustedPeer),
    lanService: overrides.lanService || { listPeers: () => [fixture.endpoint] },
    connector: overrides.connector,
    clock: () => NOW,
    timeouts: {
      connectMs: 100,
      bootstrapMs: 100,
      controlTtlMs: 1000,
      handshakeMs: 1000,
      idleMs: 1000,
      writeMs: 1000,
      operationMs: 1000,
      pauseMs: 1000,
      closingMs: 1000,
      ...(overrides.timeouts || {})
    }
  });
}

function createFixture(root = null, sourceDefinitions = []) {
  const localDevice = createDevice('Fixture desktop');
  const remoteDevice = createDevice('Fixture Android');
  const entries = [];
  const sources = [];
  for (const source of sourceDefinitions) {
    const sha256 = crypto.createHash('sha256').update(source.bytes).digest('hex');
    const sourcePath = path.join(root, source.name);
    fs.writeFileSync(sourcePath, source.bytes);
    entries.push({ kind: 'file', path: source.name, size: source.bytes.length, sha256 });
    sources.push({ path: source.name, sourcePath, size: source.bytes.length, sha256 });
  }
  if (entries.length === 0) entries.push({ kind: 'directory', path: 'empty-folder' });
  const manifest = createTransferManifest({ taskId: createTaskId(), entries });
  const trustedPeer = {
    identity: publicIdentity(remoteDevice),
    displayName: remoteDevice.deviceName,
    permissions: { transfer: true, libraryRead: false, libraryUpload: false },
    pairedAt: NOW,
    lastSeen: NOW,
    revokedAt: null,
    updatedAt: NOW
  };
  return {
    localDevice,
    remoteDevice,
    trustedPeer,
    endpoint: {
      ...publicIdentity(remoteDevice),
      host: '192.0.2.10',
      port: 47888,
      capabilities: ['transfer'],
      lastSeen: NOW
    },
    checkpoint: {
      files: manifest.entries.filter((entry) => entry.kind === 'file').map((entry) => ({
        path: entry.path,
        size: entry.size,
        committedOffset: 0,
        completed: false
      })),
      totalTransferred: 0,
      nextSequence: 0
    },
    job: {
      taskId: manifest.taskId,
      peerDeviceId: remoteDevice.deviceId,
      direction: 'outgoing',
      status: 'transferring',
      manifest,
      sources,
      sourceMappingStatus: 'available',
      recoverable: true,
      progress: {
        totalFiles: manifest.totalFiles,
        completedFiles: 0,
        totalBytes: manifest.totalBytes,
        transferredBytes: 0
      }
    }
  };
}

function startRemoteBootstrap({ stream, localDevice, remoteDevice, decision, onWriteChunk }) {
  const decoder = new WireFrameDecoder();
  const bootstrap = deferred();
  const session = deferred();
  const state = { writer: null };

  const onData = (chunk) => {
    let frames;
    try {
      frames = decoder.push(chunk);
    } catch (error) {
      bootstrap.reject(error);
      return;
    }
    if (frames.length === 0) return;
    stream.removeListener('data', onData);
    try {
      assert.strictEqual(frames.length, 1);
      const frame = frames[0];
      assert.strictEqual(frame.header.type, MESSAGE_TYPES.TRANSFER_MANIFEST);
      const envelope = decodeTransferMessage(TYPE_TRANSFER_MANIFEST, frame.payload, { now: NOW });
      assert.strictEqual(verifyTransferMessage(
        TYPE_TRANSFER_MANIFEST,
        envelope,
        localDevice.signingPublicKey,
        { now: NOW }
      ), true);
      assert.strictEqual(envelope.senderDeviceId, localDevice.deviceId);
      assert.strictEqual(envelope.receiverDeviceId, remoteDevice.deviceId);

      const signedDecision = signTransferMessage(TYPE_TRANSFER_DECISION, {
        app: APP_ID,
        protocolVersion: PROTOCOL_VERSION,
        type: TYPE_TRANSFER_DECISION,
        taskId: envelope.manifest.taskId,
        senderDeviceId: remoteDevice.deviceId,
        receiverDeviceId: localDevice.deviceId,
        decision,
        sessionId: envelope.sessionId,
        issuedAt: NOW,
        expiresAt: NOW + 1000
      }, remoteDevice.signingPrivateKey, { now: NOW });
      const decisionResponse = encodeWireFrame({
        header: { app: APP_ID, protocolVersion: PROTOCOL_VERSION, type: MESSAGE_TYPES.TRANSFER_DECISION },
        payload: encodeTransferMessage(TYPE_TRANSFER_DECISION, signedDecision, { now: NOW })
      });
      const initial = initialCheckpoint(envelope.manifest);
      const signedResume = decision === 'accepted'
        ? signTransferMessage(TYPE_TRANSFER_RESUME, {
            app: APP_ID,
            protocolVersion: PROTOCOL_VERSION,
            type: TYPE_TRANSFER_RESUME,
            taskId: envelope.manifest.taskId,
            sessionId: envelope.sessionId,
            senderDeviceId: remoteDevice.deviceId,
            receiverDeviceId: localDevice.deviceId,
            manifestHash: manifestHash(envelope.manifest),
            files: initial.files,
            nextSequence: initial.nextSequence,
            totalTransferred: initial.totalTransferred,
            issuedAt: NOW,
            expiresAt: NOW + 1000
          }, remoteDevice.signingPrivateKey, { now: NOW })
        : null;
      const resumeResponse = signedResume === null ? Buffer.alloc(0) : encodeWireFrame({
        header: { app: APP_ID, protocolVersion: PROTOCOL_VERSION, type: MESSAGE_TYPES.TRANSFER_RESUME },
        payload: encodeTransferMessage(TYPE_TRANSFER_RESUME, signedResume, { now: NOW })
      });
      const response = Buffer.concat([decisionResponse, resumeResponse]);
      stream.write(response, (error) => {
        if (error) {
          bootstrap.reject(error);
          session.reject(error);
          return;
        }
        bootstrap.resolve(envelope);
        if (decision !== 'accepted') {
          session.resolve(null);
          return;
        }
        try {
          state.writer = startRemoteSession({
            stream,
            localDevice,
            remoteDevice,
            envelope,
            initialResume: signedResume,
            onWriteChunk,
            done: session
          });
        } catch (sessionError) {
          session.reject(sessionError);
        }
      });
    } catch (error) {
      bootstrap.reject(error);
      session.reject(error);
    }
  };
  stream.on('data', onData);
  return {
    bootstrapDone: bootstrap.promise,
    sessionDone: session.promise,
    get writer() { return state.writer; }
  };
}

function startRemoteSession({ stream, localDevice, remoteDevice, envelope, initialResume, onWriteChunk, done }) {
  const manifestSha256 = manifestHash(envelope.manifest);
  const sessionKey = deriveSessionKey({
    localPrivateKeyPem: remoteDevice.encryptionPrivateKey,
    remotePublicKeyPem: rawX25519PublicKeyToPem(envelope.senderEphemeralPublicKey),
    senderDeviceId: localDevice.deviceId,
    receiverDeviceId: remoteDevice.deviceId,
    taskId: envelope.manifest.taskId,
    manifestSha256
  });
  const writer = createAuthenticatingWriter(envelope.manifest, sessionKey, onWriteChunk);
  let transferCheckpoint = advanceTransferControlCheckpoint(TYPE_TRANSFER_RESUME, initialResume, { now: NOW });
  const control = createSignedStreamControlCodec({
    localDevice: remoteDevice,
    remotePeer: localDevice,
    taskId: envelope.manifest.taskId,
    sessionId: envelope.sessionId,
    now: () => NOW,
    ttlMs: 1000
  });
  const receiver = createTransferStreamSession({
    stream,
    role: 'receiver',
    taskId: envelope.manifest.taskId,
    localPeerId: remoteDevice.deviceId,
    remotePeerId: localDevice.deviceId,
    chunkWriter: writer,
    encodeControl: control.encodeControl,
    decodeControl: control.decodeControl,
    verifyControl: control.verifyControl,
    encodeProgress: async (progress) => {
      const signed = signTransferMessage(TYPE_TRANSFER_PROGRESS, {
        app: APP_ID,
        protocolVersion: PROTOCOL_VERSION,
        type: TYPE_TRANSFER_PROGRESS,
        taskId: envelope.manifest.taskId,
        sessionId: envelope.sessionId,
        senderDeviceId: remoteDevice.deviceId,
        receiverDeviceId: localDevice.deviceId,
        manifestHash: manifestSha256,
        ...progress,
        issuedAt: NOW,
        expiresAt: NOW + 1000
      }, remoteDevice.signingPrivateKey, { now: NOW, checkpoint: transferCheckpoint });
      const encoded = encodeTransferMessage(TYPE_TRANSFER_PROGRESS, signed, {
        now: NOW,
        checkpoint: transferCheckpoint
      });
      transferCheckpoint = advanceTransferControlCheckpoint(TYPE_TRANSFER_PROGRESS, signed, {
        now: NOW,
        checkpoint: transferCheckpoint
      });
      return encoded;
    },
    decodeProgress: async () => { throw new Error('Remote receiver cannot decode progress'); },
    commitProgress: async () => { throw new Error('Remote receiver cannot commit progress'); },
    handshakeTimeoutMs: 1000,
    idleTimeoutMs: 1000,
    writeTimeoutMs: 1000,
    operationTimeoutMs: 1000,
    pauseTimeoutMs: 1000,
    closingTimeoutMs: 1000
  });
  receiver.start().then(done.resolve, done.reject);
  return writer;
}

function createAuthenticatingWriter(manifest, sessionKey, onWriteChunk) {
  const expected = new Map(manifest.entries.filter((entry) => entry.kind === 'file').map((entry) => [entry.path, entry]));
  const parts = new Map(Array.from(expected.keys(), (name) => [name, []]));
  const offsets = new Map(Array.from(expected.keys(), (name) => [name, 0]));
  let nextSequence = 0;
  return {
    files: new Map(),
    completed: 0,
    async writeChunk(chunk) {
      assert.ok(expected.has(chunk.path));
      assert.strictEqual(chunk.offset, offsets.get(chunk.path));
      assert.strictEqual(chunk.sequence, nextSequence);
      const plaintext = decryptChunk({
        key: sessionKey,
        nonce: chunk.nonce,
        taskId: chunk.taskId,
        path: chunk.path,
        offset: chunk.offset,
        sequence: chunk.sequence,
        plainLength: chunk.plainLength,
        ciphertext: chunk.ciphertext,
        authTag: chunk.authTag
      });
      parts.get(chunk.path).push(plaintext);
      offsets.set(chunk.path, chunk.offset + chunk.plainLength);
      nextSequence += 1;
      if (onWriteChunk) await onWriteChunk(chunk);
      return {
        path: chunk.path,
        fileSize: expected.get(chunk.path).size,
        committedOffset: offsets.get(chunk.path),
        completed: offsets.get(chunk.path) === expected.get(chunk.path).size,
        nextSequence,
        totalTransferred: Array.from(offsets.values()).reduce((total, value) => total + value, 0)
      };
    },
    async complete() {
      this.completed += 1;
      for (const [name, entry] of expected) {
        const bytes = Buffer.concat(parts.get(name));
        assert.strictEqual(bytes.length, entry.size);
        assert.strictEqual(crypto.createHash('sha256').update(bytes).digest('hex'), entry.sha256);
        this.files.set(name, bytes);
      }
      sessionKey.fill(0);
      return { published: true };
    },
    async cancel() {
      sessionKey.fill(0);
    }
  };
}

function initialCheckpoint(manifest) {
  return {
    files: manifest.entries.filter((entry) => entry.kind === 'file').map((entry) => ({
      path: entry.path,
      size: entry.size,
      committedOffset: 0,
      completed: false
    })),
    totalTransferred: 0,
    nextSequence: 0
  };
}

function manifestHash(manifest) {
  return crypto.createHash('sha256')
    .update(serializeTransferManifest(manifest), 'utf8')
    .digest('hex');
}

function createDevice(deviceName) {
  const signing = createKeyPair('ed25519');
  const encryption = createX25519KeyPair();
  return {
    deviceId: crypto.createHash('sha256').update(signing.publicKey).digest('hex').slice(0, 16),
    deviceName,
    fingerprint: fingerprintFor(signing.publicKey),
    signingPublicKey: signing.publicKey,
    signingPrivateKey: signing.privateKey,
    encryptionPublicKey: encryption.publicKey,
    encryptionPrivateKey: encryption.privateKey
  };
}

function publicIdentity(device) {
  return {
    deviceId: device.deviceId,
    deviceName: device.deviceName,
    fingerprint: device.fingerprint,
    signingPublicKey: device.signingPublicKey,
    encryptionPublicKey: device.encryptionPublicKey
  };
}

function peerStore(peer) {
  return { getTrustedPeer: () => peer };
}

function rawX25519PublicKeyToPem(raw) {
  const bytes = Buffer.from(raw, 'base64url');
  const der = Buffer.concat([X25519_PUBLIC_DER_PREFIX, bytes]);
  return crypto.createPublicKey({ key: der, type: 'spki', format: 'der' })
    .export({ type: 'spki', format: 'pem' });
}

function createMemoryPair() {
  const left = new MemoryDuplex();
  const right = new MemoryDuplex();
  left.peer = right;
  right.peer = left;
  return { left, right };
}

class MemoryDuplex extends Duplex {
  constructor() {
    super();
    this.peer = null;
  }

  _read() {}

  _write(chunk, _encoding, callback) {
    if (!this.peer || this.peer.destroyed) {
      callback(new Error('Memory peer is closed'));
      return;
    }
    this.peer.push(Buffer.from(chunk));
    callback();
  }

  _final(callback) {
    if (this.peer && !this.peer.destroyed) this.peer.push(null);
    callback();
  }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  promise.catch(() => {});
  return { promise, resolve, reject };
}

async function settle(promise) {
  try {
    return { status: 'fulfilled', value: await promise };
  } catch (reason) {
    return { status: 'rejected', reason };
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

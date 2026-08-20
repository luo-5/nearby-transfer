'use strict';

const crypto = require('crypto');
const net = require('net');
const { bootstrapOutgoingTransfer } = require('./desktop-transfer-bootstrap');
const { createEncryptedChunkReader } = require('./encrypted-chunk-reader');
const { createSignedStreamControlCodec } = require('./signed-stream-control');
const { MAX_SEQUENCE, deriveSessionKey } = require('./transfer-session-crypto');
const { createTransferStreamSession } = require('./transfer-stream-session');
const { JOB_DIRECTION, JOB_STATUS, DIAGNOSTIC_CODE } = require('./transfer-job-store');
const { normalizeTransferManifest, serializeTransferManifest } = require('./transfer-manifest');
const {
  TYPE_TRANSFER_PROGRESS,
  advanceTransferControlCheckpoint,
  decodeTransferMessage
} = require('./transfer-message-codec');
const { verifyTransferMessage } = require('./transfer-message-auth');

const DEFAULT_TIMEOUTS = Object.freeze({
  connectMs: 10 * 1000,
  bootstrapMs: 90 * 1000,
  controlTtlMs: 30 * 1000,
  handshakeMs: 10 * 1000,
  idleMs: 30 * 1000,
  writeMs: 30 * 1000,
  operationMs: 30 * 1000,
  pauseMs: 2 * 60 * 1000,
  closingMs: 10 * 1000
});
const MAX_TIMEOUT_MS = 10 * 60 * 1000;
const TIMEOUT_KEYS = Object.freeze(Object.keys(DEFAULT_TIMEOUTS));

const ERROR_CODE = Object.freeze({
  CONNECT_FAILED: 'TRANSFER_CONNECT_FAILED',
  DISCOVERY_IDENTITY_MISMATCH: 'TRANSFER_DISCOVERY_IDENTITY_MISMATCH',
  JOB_INVALID: 'TRANSFER_JOB_INVALID',
  MANIFEST_REJECTED: 'TRANSFER_MANIFEST_REJECTED',
  PEER_OFFLINE: 'TRANSFER_PEER_OFFLINE',
  PEER_PERMISSION_DENIED: 'TRANSFER_PEER_PERMISSION_DENIED',
  PEER_REVOKED: 'TRANSFER_PEER_REVOKED'
});

/**
 * Create the runtime used by DesktopTransferScheduler for one outgoing job.
 * Setup is deliberately asynchronous: no executor is returned until the
 * authenticated peer has accepted the manifest and the stream session owns
 * the connected socket.
 */
async function createDesktopTransferExecutor(input) {
  const config = normalizeInput(input);
  const job = normalizeOutgoingJob(config.job);
  if (!config.checkpoint || typeof config.checkpoint !== 'object' ||
      config.checkpoint.totalTransferred !== config.job.progress.transferredBytes) {
    throw diagnosticError(
      'Outgoing transfer checkpoint does not match the persisted job progress',
      ERROR_CODE.JOB_INVALID,
      DIAGNOSTIC_CODE.PROTOCOL_ERROR
    );
  }
  throwIfAborted(config.signal);

  const trustedPeer = requireTrustedTransferPeer(config.trustedPeerStore, job.peerDeviceId);
  const endpoint = requireOnlineTrustedEndpoint(config.lanService, trustedPeer);
  throwIfAborted(config.signal);

  let stream = null;
  let chunkReader = null;
  let sessionKey = null;
  let removeSetupAbort = () => {};
  const attemptController = new AbortController();
  const removeAbortRelay = relayAbort(config.signal, attemptController);

  try {
    stream = await connectBounded({
      connector: config.connector,
      endpoint,
      signal: attemptController.signal,
      timeoutMs: config.timeouts.connectMs
    });
    const onSetupAbort = () => safeDestroy(stream);
    attemptController.signal.addEventListener('abort', onSetupAbort, { once: true });
    removeSetupAbort = () => attemptController.signal.removeEventListener('abort', onSetupAbort);
    if (attemptController.signal.aborted) onSetupAbort();
    throwIfAborted(attemptController.signal);

    const sessionId = crypto.randomBytes(16).toString('base64url');
    const ephemeral = createEphemeralX25519KeyPair();
    const bootstrap = await bootstrapOutgoingTransfer({
      stream,
      localDevice: config.localDevice,
      remotePeer: trustedPeer,
      manifest: job.manifest,
      checkpoint: config.checkpoint,
      senderEphemeralPublicKey: ephemeral.publicKeyRaw,
      sessionId,
      clock: config.clock,
      ttlMs: config.timeouts.controlTtlMs,
      timeoutMs: config.timeouts.bootstrapMs
    }).catch((error) => {
      throw decorateBootstrapError(error);
    });

    if (bootstrap.decision !== 'accepted') {
      throw createDecisionError(bootstrap.decision);
    }
    throwIfAborted(attemptController.signal);

    const manifestSha256 = crypto.createHash('sha256')
      .update(serializeTransferManifest(job.manifest), 'utf8')
      .digest('hex');
    sessionKey = deriveSessionKey({
      localPrivateKeyPem: ephemeral.privateKey.export({ type: 'pkcs8', format: 'pem' }),
      remotePublicKeyPem: trustedPeer.identity.encryptionPublicKey,
      senderDeviceId: config.localDevice.deviceId,
      receiverDeviceId: trustedPeer.identity.deviceId,
      taskId: job.taskId,
      manifestSha256
    });

    chunkReader = createEncryptedChunkReader({
      manifest: job.manifest,
      sourceFiles: job.sources,
      sessionKey,
      signal: attemptController.signal,
      resumeCheckpoint: bootstrap.checkpoint
    });
    sessionKey.fill(0);
    sessionKey = null;

    const progress = createProgressCommitter({
      bootstrap,
      commitRemoteCheckpoint: config.commitRemoteCheckpoint,
      manifest: job.manifest,
      manifestSha256,
      sessionId,
      localDeviceId: config.localDevice.deviceId,
      remoteDeviceId: trustedPeer.identity.deviceId,
      remoteSigningPublicKey: trustedPeer.identity.signingPublicKey,
      clock: config.clock
    });
    const control = createSignedStreamControlCodec({
      localDevice: config.localDevice,
      remotePeer: trustedPeer,
      taskId: job.taskId,
      sessionId,
      now: config.clock,
      ttlMs: config.timeouts.controlTtlMs
    });
    const session = createTransferStreamSession({
      stream,
      role: 'sender',
      taskId: job.taskId,
      localPeerId: config.localDevice.deviceId,
      remotePeerId: trustedPeer.identity.deviceId,
      chunkReader,
      encodeControl: control.encodeControl,
      decodeControl: control.decodeControl,
      verifyControl: control.verifyControl,
      encodeProgress: () => { throw new Error('Desktop sender cannot encode receiver progress'); },
      decodeProgress: progress.decode,
      commitProgress: progress.commit,
      signal: attemptController.signal,
      handshakeTimeoutMs: config.timeouts.handshakeMs,
      idleTimeoutMs: config.timeouts.idleMs,
      writeTimeoutMs: config.timeouts.writeMs,
      operationTimeoutMs: config.timeouts.operationMs,
      pauseTimeoutMs: config.timeouts.pauseMs,
      closingTimeoutMs: config.timeouts.closingMs
    });
    removeSetupAbort();

    let closed = false;
    let settled = false;
    const done = Promise.resolve(session.start()).finally(() => {
      settled = true;
      removeAbortRelay();
      safeDestroy(stream);
    });

    return Object.freeze({
      done,
      pause: () => session.pause(),
      resume: () => session.resume(),
      async cancel(reason) {
        if (!attemptController.signal.aborted) attemptController.abort(reason);
        try {
          await session.cancel(reason);
        } catch (error) {
          if (!isAbortError(error)) throw error;
        } finally {
          safeDestroy(stream);
        }
      },
      async close() {
        if (closed) return;
        closed = true;
        if (!settled && !attemptController.signal.aborted) {
          attemptController.abort(new Error('Transfer executor closed'));
          try {
            await session.cancel(attemptController.signal.reason);
          } catch (error) {
            if (!isAbortError(error)) throw error;
          }
        }
        safeDestroy(stream);
        removeAbortRelay();
      }
    });
  } catch (error) {
    if (!attemptController.signal.aborted) attemptController.abort(error);
    if (chunkReader && typeof chunkReader.return === 'function') {
      try {
        await chunkReader.return();
      } catch (_) {
        // Preserve the setup failure while still releasing the reader key copy.
      }
    }
    safeDestroy(stream);
    removeSetupAbort();
    removeAbortRelay();
    throw normalizeExecutorError(error, config.signal);
  } finally {
    if (sessionKey) sessionKey.fill(0);
    if (!stream || stream.destroyed) removeAbortRelay();
  }
}

function normalizeInput(input) {
  assertPlainObject(input, 'Desktop transfer executor input');
  for (const key of [
    'job', 'checkpoint', 'signal', 'commitRemoteCheckpoint',
    'localDevice', 'trustedPeerStore', 'lanService'
  ]) {
    if (!Object.hasOwn(input, key)) throw new TypeError(`Desktop transfer executor input is missing ${key}`);
  }
  if (!input.signal || typeof input.signal.aborted !== 'boolean' ||
      typeof input.signal.addEventListener !== 'function' || typeof input.signal.removeEventListener !== 'function') {
    throw new TypeError('Desktop transfer executor requires an AbortSignal');
  }
  if (typeof input.commitRemoteCheckpoint !== 'function') {
    throw new TypeError('Desktop transfer executor requires commitRemoteCheckpoint');
  }
  if (!input.localDevice || typeof input.localDevice !== 'object' ||
      typeof input.localDevice.deviceId !== 'string' || typeof input.localDevice.signingPrivateKey !== 'string') {
    throw new TypeError('Desktop transfer executor requires a signing-capable local device');
  }
  if (!input.trustedPeerStore || typeof input.trustedPeerStore.getTrustedPeer !== 'function') {
    throw new TypeError('Desktop transfer executor requires a trusted peer store');
  }
  if (!input.lanService || typeof input.lanService.listPeers !== 'function') {
    throw new TypeError('Desktop transfer executor requires a LAN discovery service');
  }
  const connector = input.connector === undefined ? defaultConnector : input.connector;
  if (typeof connector !== 'function') throw new TypeError('Desktop transfer connector must be a function');
  const clock = input.clock === undefined ? Date.now : input.clock;
  if (typeof clock !== 'function') throw new TypeError('Desktop transfer clock must be a function');
  return {
    job: input.job,
    checkpoint: input.checkpoint,
    signal: input.signal,
    commitRemoteCheckpoint: input.commitRemoteCheckpoint,
    localDevice: input.localDevice,
    trustedPeerStore: input.trustedPeerStore,
    lanService: input.lanService,
    connector,
    clock,
    timeouts: normalizeTimeouts(input.timeouts)
  };
}

function normalizeOutgoingJob(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw diagnosticError('Desktop transfer job is invalid', ERROR_CODE.JOB_INVALID, DIAGNOSTIC_CODE.PROTOCOL_ERROR);
  }
  if (value.direction !== JOB_DIRECTION.OUTGOING || value.status !== JOB_STATUS.TRANSFERRING) {
    throw diagnosticError('Desktop transfer executor requires an active outgoing job', ERROR_CODE.JOB_INVALID, DIAGNOSTIC_CODE.PROTOCOL_ERROR);
  }
  const manifest = normalizeTransferManifest(value.manifest);
  if (value.taskId !== manifest.taskId || typeof value.peerDeviceId !== 'string') {
    throw diagnosticError('Desktop transfer job does not match its manifest', ERROR_CODE.JOB_INVALID, DIAGNOSTIC_CODE.PROTOCOL_ERROR);
  }
  if (value.sourceMappingStatus !== 'available' || !Array.isArray(value.sources)) {
    throw diagnosticError('Outgoing transfer source file mappings are unavailable', ERROR_CODE.JOB_INVALID, DIAGNOSTIC_CODE.IO_ERROR);
  }
  const files = manifest.entries.filter((entry) => entry.kind === 'file');
  if (value.sources.length !== files.length) {
    throw diagnosticError('Outgoing transfer sources must map every manifest file exactly once', ERROR_CODE.JOB_INVALID, DIAGNOSTIC_CODE.IO_ERROR);
  }
  const expected = new Map(files.map((file) => [file.path, file]));
  const seen = new Set();
  const sources = value.sources.map((source) => {
    if (!source || typeof source !== 'object' || Array.isArray(source) || seen.has(source.path)) {
      throw diagnosticError('Outgoing transfer source mappings are invalid', ERROR_CODE.JOB_INVALID, DIAGNOSTIC_CODE.IO_ERROR);
    }
    const file = expected.get(source.path);
    if (!file || typeof source.sourcePath !== 'string' || source.sourcePath.length === 0 ||
        source.size !== file.size || source.sha256 !== file.sha256) {
      throw diagnosticError('Outgoing transfer source metadata does not match the manifest', ERROR_CODE.JOB_INVALID, DIAGNOSTIC_CODE.IO_ERROR);
    }
    seen.add(source.path);
    return { path: source.path, sourcePath: source.sourcePath, size: source.size, sha256: source.sha256 };
  });
  if (!value.progress || !Number.isSafeInteger(value.progress.transferredBytes) || value.progress.transferredBytes < 0) {
    throw diagnosticError('Outgoing transfer progress is invalid', ERROR_CODE.JOB_INVALID, DIAGNOSTIC_CODE.PROTOCOL_ERROR);
  }
  return { taskId: value.taskId, peerDeviceId: value.peerDeviceId, manifest, sources };
}

function requireTrustedTransferPeer(store, deviceId) {
  let peer;
  try {
    peer = store.getTrustedPeer(deviceId, { includeRevoked: true });
  } catch (error) {
    throw diagnosticError('Unable to re-read the trusted transfer peer', ERROR_CODE.PEER_REVOKED, DIAGNOSTIC_CODE.PEER_REVOKED, error);
  }
  if (!peer || peer.revokedAt !== null) {
    throw diagnosticError('The transfer peer is missing or revoked', ERROR_CODE.PEER_REVOKED, DIAGNOSTIC_CODE.PEER_REVOKED);
  }
  if (!peer.permissions || peer.permissions.transfer !== true) {
    throw diagnosticError('The trusted peer does not have transfer permission', ERROR_CODE.PEER_PERMISSION_DENIED, DIAGNOSTIC_CODE.PEER_REVOKED);
  }
  if (!peer.identity || peer.identity.deviceId !== deviceId ||
      typeof peer.identity.signingPublicKey !== 'string' || typeof peer.identity.encryptionPublicKey !== 'string') {
    throw diagnosticError('The trusted peer identity is invalid', ERROR_CODE.PEER_REVOKED, DIAGNOSTIC_CODE.PEER_REVOKED);
  }
  return peer;
}

function requireOnlineTrustedEndpoint(lanService, trustedPeer) {
  const peers = lanService.listPeers();
  if (!Array.isArray(peers)) throw new TypeError('LAN discovery service returned an invalid peer list');
  const discovered = peers.find((peer) => peer && peer.deviceId === trustedPeer.identity.deviceId);
  if (!discovered) {
    throw diagnosticError('The trusted transfer peer is offline', ERROR_CODE.PEER_OFFLINE, DIAGNOSTIC_CODE.NETWORK_INTERRUPTED);
  }
  const identity = trustedPeer.identity;
  if (discovered.deviceId !== identity.deviceId || discovered.deviceName !== identity.deviceName ||
      discovered.fingerprint !== identity.fingerprint || discovered.signingPublicKey !== identity.signingPublicKey ||
      discovered.encryptionPublicKey !== identity.encryptionPublicKey) {
    throw diagnosticError(
      'The discovered peer identity does not match the trusted identity',
      ERROR_CODE.DISCOVERY_IDENTITY_MISMATCH,
      DIAGNOSTIC_CODE.PEER_REVOKED
    );
  }
  if (typeof discovered.host !== 'string' || discovered.host.length === 0 || discovered.host.includes('\0') ||
      !Number.isSafeInteger(discovered.port) || discovered.port < 1 || discovered.port > 65535) {
    throw diagnosticError('The discovered transfer endpoint is invalid', ERROR_CODE.PEER_OFFLINE, DIAGNOSTIC_CODE.NETWORK_INTERRUPTED);
  }
  return Object.freeze({ host: discovered.host, port: discovered.port, peer: discovered });
}

function createEphemeralX25519KeyPair() {
  const pair = crypto.generateKeyPairSync('x25519');
  const publicJwk = pair.publicKey.export({ format: 'jwk' });
  if (!publicJwk || publicJwk.kty !== 'OKP' || publicJwk.crv !== 'X25519' || typeof publicJwk.x !== 'string' ||
      Buffer.from(publicJwk.x, 'base64url').length !== 32 || Buffer.from(publicJwk.x, 'base64url').toString('base64url') !== publicJwk.x) {
    throw new Error('Unable to export a canonical ephemeral X25519 public key');
  }
  return Object.freeze({
    publicKeyRaw: publicJwk.x,
    privateKey: pair.privateKey
  });
}

async function connectBounded({ connector, endpoint, signal, timeoutMs }) {
  throwIfAborted(signal);
  let settled = false;
  let resolvedStream = null;
  let timer;
  let removeAbort = () => {};
  const operation = Promise.resolve().then(() => connector(Object.freeze({
    host: endpoint.host,
    port: endpoint.port,
    peer: endpoint.peer,
    signal,
    timeoutMs
  })));

  const guarded = new Promise((resolve, reject) => {
    const finish = (callback, value) => {
      if (settled) {
        if (callback === resolve) safeDestroy(value);
        return;
      }
      settled = true;
      clearTimeout(timer);
      removeAbort();
      callback(value);
    };
    timer = setTimeout(() => {
      const error = diagnosticError(
        `Transfer connection timed out after ${timeoutMs} milliseconds`,
        ERROR_CODE.CONNECT_FAILED,
        DIAGNOSTIC_CODE.NETWORK_INTERRUPTED
      );
      error.name = 'TimeoutError';
      finish(reject, error);
    }, timeoutMs);
    const onAbort = () => finish(reject, createAbortError(signal.reason));
    signal.addEventListener('abort', onAbort, { once: true });
    removeAbort = () => signal.removeEventListener('abort', onAbort);
    operation.then(
      (stream) => {
        resolvedStream = stream;
        try {
          assertDuplex(stream);
          finish(resolve, stream);
        } catch (error) {
          safeDestroy(stream);
          finish(reject, error);
        }
      },
      (error) => finish(reject, diagnosticError(
        'Unable to connect to the transfer peer',
        ERROR_CODE.CONNECT_FAILED,
        DIAGNOSTIC_CODE.NETWORK_INTERRUPTED,
        error
      ))
    );
  });

  try {
    return await guarded;
  } catch (error) {
    safeDestroy(resolvedStream);
    throw error;
  }
}

function defaultConnector({ host, port, signal, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      socket.removeListener('connect', onConnect);
      socket.removeListener('error', onError);
      callback(value);
    };
    const onConnect = () => {
      socket.setNoDelay(true);
      finish(resolve, socket);
    };
    const onError = (error) => {
      safeDestroy(socket);
      finish(reject, error);
    };
    const onAbort = () => {
      safeDestroy(socket);
      finish(reject, createAbortError(signal.reason));
    };
    const timer = setTimeout(() => {
      const error = new Error(`Transfer TCP connection timed out after ${timeoutMs} milliseconds`);
      error.name = 'TimeoutError';
      safeDestroy(socket);
      finish(reject, error);
    }, timeoutMs);
    socket.once('connect', onConnect);
    socket.once('error', onError);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

function createProgressCommitter(input) {
  let checkpoint = input.bootstrap.checkpoint;
  let controlCheckpoint = input.bootstrap.controlCheckpoint;
  const manifestFiles = new Map(
    input.manifest.entries
      .filter((entry) => entry.kind === 'file')
      .map((entry) => [entry.path, entry])
  );

  return Object.freeze({
    decode(encoded) {
      const now = readClock(input.clock);
      const normalized = decodeTransferMessage(TYPE_TRANSFER_PROGRESS, encoded, {
        now,
        checkpoint: controlCheckpoint
      });
      if (!verifyTransferMessage(
        TYPE_TRANSFER_PROGRESS,
        normalized,
        input.remoteSigningPublicKey,
        { now, checkpoint: controlCheckpoint }
      )) {
        throw new Error('Transfer progress signature verification failed');
      }
      if (normalized.taskId !== input.manifest.taskId ||
          normalized.sessionId !== input.sessionId ||
          normalized.senderDeviceId !== input.remoteDeviceId ||
          normalized.receiverDeviceId !== input.localDeviceId ||
          normalized.manifestHash !== input.manifestSha256) {
        throw new Error('Transfer progress binding does not match the authenticated session');
      }
      return normalized;
    },

    async commit(message, sentChunk) {
      const relativePath = sentChunk.relativePath || sentChunk.path;
      const expectedFile = manifestFiles.get(relativePath);
      const currentFile = checkpoint.files.find((file) => file.path === relativePath);
      if (!expectedFile || !currentFile || sentChunk.sequence !== checkpoint.nextSequence ||
          sentChunk.offset !== currentFile.committedOffset) {
        throw new Error('Transfer progress does not acknowledge the outstanding encrypted chunk');
      }
      const committedOffset = sentChunk.offset + sentChunk.plainLength;
      const completed = committedOffset === expectedFile.size;
      const nextSequence = sentChunk.sequence === MAX_SEQUENCE
        ? MAX_SEQUENCE
        : sentChunk.sequence + 1;
      if (message.path !== relativePath || message.fileSize !== expectedFile.size ||
          message.committedOffset !== committedOffset || message.completed !== completed ||
          message.nextSequence !== nextSequence ||
          message.totalTransferred !== checkpoint.totalTransferred + sentChunk.plainLength) {
        throw new Error('Transfer progress acknowledgement does not match the outstanding encrypted chunk');
      }

      const candidate = Object.freeze({
        files: Object.freeze(checkpoint.files.map((file) => Object.freeze(
          file.path === message.path
            ? {
                path: file.path,
                size: file.size,
                committedOffset: message.committedOffset,
                completed: message.completed
              }
            : { ...file }
        ))),
        totalTransferred: message.totalTransferred,
        nextSequence: message.nextSequence
      });
      const now = readClock(input.clock);
      const committed = await input.commitRemoteCheckpoint(candidate, now);
      assertCommittedCheckpoint(committed, candidate);
      controlCheckpoint = advanceTransferControlCheckpoint(TYPE_TRANSFER_PROGRESS, message, {
        now,
        checkpoint: controlCheckpoint
      });
      checkpoint = candidate;
      return committed;
    }
  });
}

function assertCommittedCheckpoint(actual, expected) {
  if (!actual || typeof actual !== 'object' ||
      actual.totalTransferred !== expected.totalTransferred ||
      actual.nextSequence !== expected.nextSequence ||
      !Array.isArray(actual.files) || actual.files.length !== expected.files.length) {
    throw new Error('Persisted transfer checkpoint does not match the receiver acknowledgement');
  }
  for (let index = 0; index < expected.files.length; index += 1) {
    const left = actual.files[index];
    const right = expected.files[index];
    if (!left || left.path !== right.path || left.size !== right.size ||
        left.committedOffset !== right.committedOffset || left.completed !== right.completed) {
      throw new Error('Persisted transfer checkpoint does not match the receiver acknowledgement');
    }
  }
}

function createDecisionError(decision) {
  const diagnostic = decision === 'unauthorized'
    ? DIAGNOSTIC_CODE.PEER_REVOKED
    : decision === 'busy'
      ? DIAGNOSTIC_CODE.NETWORK_INTERRUPTED
      : decision === 'rejected'
        ? DIAGNOSTIC_CODE.USER_CANCELLED
        : DIAGNOSTIC_CODE.PROTOCOL_ERROR;
  const error = diagnosticError(
    `Remote peer rejected the transfer manifest: ${decision}`,
    ERROR_CODE.MANIFEST_REJECTED,
    diagnostic
  );
  error.decision = decision;
  return error;
}

function decorateBootstrapError(error) {
  const message = String(error && error.message ? error.message : error);
  const diagnostic = /timed out|ended|closed|socket|connection/i.test(message)
    ? DIAGNOSTIC_CODE.NETWORK_INTERRUPTED
    : DIAGNOSTIC_CODE.PROTOCOL_ERROR;
  return diagnosticError('Transfer manifest negotiation failed', ERROR_CODE.CONNECT_FAILED, diagnostic, error);
}

function normalizeExecutorError(error, upstreamSignal) {
  if (upstreamSignal.aborted || isAbortError(error)) return createAbortError(upstreamSignal.reason || error);
  return error instanceof Error ? error : new Error(String(error));
}

function diagnosticError(message, code, diagnosticCode, cause) {
  const error = cause === undefined ? new Error(message) : new Error(message, { cause });
  error.code = code;
  error.diagnosticCode = diagnosticCode;
  return error;
}

function normalizeTimeouts(value) {
  if (value === undefined) return DEFAULT_TIMEOUTS;
  assertPlainObject(value, 'Desktop transfer timeouts');
  for (const key of Object.keys(value)) {
    if (!TIMEOUT_KEYS.includes(key)) throw new TypeError(`Desktop transfer timeouts contains unknown field ${key}`);
  }
  const result = {};
  for (const key of TIMEOUT_KEYS) {
    const timeout = value[key] === undefined ? DEFAULT_TIMEOUTS[key] : value[key];
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > MAX_TIMEOUT_MS) {
      throw new RangeError(`Desktop transfer timeout ${key} must be between 1 and ${MAX_TIMEOUT_MS} milliseconds`);
    }
    result[key] = timeout;
  }
  return Object.freeze(result);
}

function relayAbort(source, target) {
  const onAbort = () => {
    if (!target.signal.aborted) target.abort(source.reason);
  };
  source.addEventListener('abort', onAbort, { once: true });
  if (source.aborted) onAbort();
  return () => source.removeEventListener('abort', onAbort);
}

function readClock(clock) {
  const value = clock();
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError('Desktop transfer clock must return a positive safe integer');
  }
  return value;
}

function throwIfAborted(signal) {
  if (signal.aborted) throw createAbortError(signal.reason);
}

function createAbortError(reason) {
  const error = new Error('Desktop outgoing transfer was aborted');
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  error.diagnosticCode = DIAGNOSTIC_CODE.USER_CANCELLED;
  if (reason !== undefined) error.cause = reason;
  return error;
}

function isAbortError(error) {
  return Boolean(error && (error.name === 'AbortError' || error.code === 'ABORT_ERR'));
}

function assertDuplex(stream) {
  if (!stream || typeof stream !== 'object' || typeof stream.on !== 'function' ||
      typeof stream.once !== 'function' || typeof stream.removeListener !== 'function' ||
      typeof stream.read !== 'function' || typeof stream.write !== 'function' ||
      typeof stream.pause !== 'function' || typeof stream.resume !== 'function' ||
      typeof stream.end !== 'function' || typeof stream.destroy !== 'function' || stream.destroyed) {
    throw new TypeError('Desktop transfer connector must return an open Node Duplex stream');
  }
}

function safeDestroy(stream) {
  if (!stream || typeof stream.destroy !== 'function' || stream.destroyed) return;
  try {
    stream.destroy();
  } catch (_) {
    // Cleanup is best effort and must not mask the primary transfer result.
  }
}

function assertPlainObject(value, subject) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${subject} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${subject} must be a plain object`);
  }
}

module.exports = {
  DEFAULT_TIMEOUTS,
  ERROR_CODE,
  createDesktopTransferExecutor
};

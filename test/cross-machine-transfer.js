'use strict';

// Cross-machine v2 transfer test. Tests the real v2 encrypted transfer protocol
// over a real TCP connection between two machines. Pairing is pre-seeded (identities
// exchanged out-of-band) so we can focus on the transfer path; the pairing protocol
// itself is covered by test/v2-lan-service-smoke.js over real TCP.
//
// Usage:
//   Receiver: node test/cross-machine-transfer.js receiver --port 47000 --receive-dir /tmp/nt-recv
//   Sender:   node test/cross-machine-transfer.js sender --host 192.168.105.129 --port 47000 \
//               --file /tmp/test-file.bin --peer-id <deviceId> --peer-name <name> \
//               --peer-signing <pem> --peer-encryption <pem> --peer-fingerprint <hex>
//
// The receiver prints RECEIVER_IDENTITY {...json...} which the orchestrator passes
// to the sender. On completion both print RESULT lines.

const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const { createKeyPair, createX25519KeyPair, fingerprintFor } = require('../src/core/crypto');
const { APP_ID, MESSAGE_TYPES, PROTOCOL_VERSION } = require('../src/v2/constants');
const { DEFAULT_TIMEOUTS, createDesktopTransferExecutor } = require('../src/v2/desktop-transfer-executor');
const { createSignedStreamControlCodec } = require('../src/v2/signed-stream-control');
const { deriveSessionKey } = require('../src/v2/transfer-session-crypto');
const { createTransferStreamSession } = require('../src/v2/transfer-stream-session');
const { createTaskId, createTransferManifest, serializeTransferManifest } = require('../src/v2/transfer-manifest');
const { buildTransferSourceManifest } = require('../src/v2/transfer-source-manifest');
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
const { planReceiveTargets } = require('../src/v2/receive-target-planner');
const { createEncryptedChunkWriter } = require('../src/v2/encrypted-chunk-writer');

const X25519_PUBLIC_DER_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');

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

function rawX25519PublicKeyToPem(raw) {
  const bytes = Buffer.from(raw, 'base64url');
  const der = Buffer.concat([X25519_PUBLIC_DER_PREFIX, bytes]);
  return crypto.createPublicKey({ key: der, type: 'spki', format: 'der' })
    .export({ type: 'spki', format: 'pem' });
}

function manifestHash(manifest) {
  return crypto.createHash('sha256').update(serializeTransferManifest(manifest), 'utf8').digest('hex');
}

function initialCheckpoint(manifest) {
  return {
    files: manifest.entries.filter((e) => e.kind === 'file').map((e) => ({
      path: e.path, size: e.size, committedOffset: 0, completed: false
    })),
    totalTransferred: 0,
    nextSequence: 0
  };
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const val = argv[i + 1];
      if (val && !val.startsWith('--')) { args[key] = val; i++; }
      else args[key] = true;
    }
  }
  return args;
}

function loadOrCreateDevice(args, defaultName) {
  const deviceName = args.name || (defaultName + '-' + os.hostname());
  const identityFile = args['identity-file'];
  if (identityFile && fs.existsSync(identityFile)) {
    // Load persistent identity (with private keys) from file
    const raw = fs.readFileSync(identityFile, 'utf8');
    const lines = raw.split('\n');
    const idLine = lines.find((l) => l.includes('"DEVICE_IDENTITY"')) || lines[0];
    const parsed = JSON.parse(idLine);
    return {
      deviceId: parsed.deviceId,
      deviceName: parsed.deviceName || deviceName,
      fingerprint: parsed.fingerprint,
      signingPublicKey: parsed.signingPublicKey,
      signingPrivateKey: parsed.signingPrivateKey,
      encryptionPublicKey: parsed.encryptionPublicKey,
      encryptionPrivateKey: parsed.encryptionPrivateKey
    };
  }
  const device = createDevice(deviceName);
  if (identityFile) {
    // Save full identity (including private keys) for reuse
    fs.writeFileSync(identityFile, JSON.stringify({ type: 'DEVICE_IDENTITY', ...device }) + '\n');
  }
  return device;
}

// ─── Receiver ──────────────────────────────────────────────────────────────

async function runReceiver(args) {
  const port = parseInt(args.port || '47000', 10);
  const receiveDir = args['receive-dir'] || path.join(os.tmpdir(), 'nt-recv-' + Date.now());
  const senderIdentityFile = args['sender-identity-file'];
  fs.mkdirSync(receiveDir, { recursive: true });

  const device = loadOrCreateDevice(args, 'Receiver');
  const identity = publicIdentity(device);

  console.log(JSON.stringify({ type: 'RECEIVER_IDENTITY', ...identity, port, receiveDir }));

  const server = net.createServer(async (socket) => {
    socket.setNoDelay(true);
    const remoteAddress = socket.remoteAddress;
    console.log(JSON.stringify({ type: 'INFO', msg: 'sender connected from ' + remoteAddress }));

    try {
      await handleIncomingTransfer(socket, device, receiveDir, senderIdentityFile);
    } catch (error) {
      console.log(JSON.stringify({ type: 'ERROR', msg: 'transfer failed: ' + error.message, stack: error.stack }));
      socket.destroy();
    }
  });

  server.listen(port, '0.0.0.0', () => {
    console.log(JSON.stringify({ type: 'INFO', msg: 'listening on 0.0.0.0:' + port }));
  });

  // keep alive for 120s after last connection
  server.timeout = 120000;
}

async function handleIncomingTransfer(socket, receiverDevice, receiveDir, senderIdentityFile) {
  // Load sender identity(ies) for signature verification. Supports comma-separated
  // file paths (for concurrent multi-sender tests) — each file is one SENDER_IDENTITY.
  let senderIdentities = [];
  if (senderIdentityFile) {
    const files = senderIdentityFile.split(',').map(f => f.trim()).filter(Boolean);
    for (const f of files) {
      try {
        const raw = fs.readFileSync(f, 'utf8');
        const lines = raw.split('\n');
        const idLine = lines.find((l) => l.includes('"SENDER_IDENTITY"')) || lines[0];
        senderIdentities.push(JSON.parse(idLine));
      } catch (_e) {}
    }
  }
  const decoder = new WireFrameDecoder();
  const bootstrapDone = deferred();
  const sessionDone = deferred();
  let envelope = null;
  let plan = null;
  let writer = null;
  let transferCheckpoint = null;

  const onData = (chunk) => {
    let frames;
    try {
      frames = decoder.push(chunk);
    } catch (error) {
      bootstrapDone.reject(error);
      return;
    }
    if (frames.length === 0) return;
    socket.removeListener('data', onData);
    try {
      const frame = frames[0];
      if (frame.header.type !== MESSAGE_TYPES.TRANSFER_MANIFEST) {
        throw new Error('expected TRANSFER_MANIFEST, got ' + frame.header.type);
      }
      const now = Date.now();
      envelope = decodeTransferMessage(TYPE_TRANSFER_MANIFEST, frame.payload, { now });
      // Find the matching sender identity by deviceId
      const matchedSender = senderIdentities.find(id => id.deviceId === envelope.senderDeviceId);
      const senderSigningKey = matchedSender ? matchedSender.signingPublicKey : null;
      if (!senderSigningKey) throw new Error('no matching sender identity for deviceId ' + envelope.senderDeviceId);
      const verified = verifyTransferMessage(TYPE_TRANSFER_MANIFEST, envelope, senderSigningKey, { now });
      if (!verified) throw new Error('manifest signature verification failed');

      // Build and send TRANSFER_DECISION (accepted)
      const signedDecision = signTransferMessage(TYPE_TRANSFER_DECISION, {
        app: APP_ID, protocolVersion: PROTOCOL_VERSION, type: TYPE_TRANSFER_DECISION,
        taskId: envelope.manifest.taskId,
        senderDeviceId: receiverDevice.deviceId,
        receiverDeviceId: envelope.senderDeviceId,
        decision: 'accepted',
        sessionId: envelope.sessionId,
        issuedAt: now, expiresAt: now + 30000
      }, receiverDevice.signingPrivateKey, { now });
      const decisionFrame = encodeWireFrame({
        header: { app: APP_ID, protocolVersion: PROTOCOL_VERSION, type: MESSAGE_TYPES.TRANSFER_DECISION },
        payload: encodeTransferMessage(TYPE_TRANSFER_DECISION, signedDecision, { now })
      });

      // Build and send TRANSFER_RESUME (initial zero checkpoint)
      const initial = initialCheckpoint(envelope.manifest);
      const signedResume = signTransferMessage(TYPE_TRANSFER_RESUME, {
        app: APP_ID, protocolVersion: PROTOCOL_VERSION, type: TYPE_TRANSFER_RESUME,
        taskId: envelope.manifest.taskId,
        sessionId: envelope.sessionId,
        senderDeviceId: receiverDevice.deviceId,
        receiverDeviceId: envelope.senderDeviceId,
        manifestHash: manifestHash(envelope.manifest),
        files: initial.files,
        nextSequence: initial.nextSequence,
        totalTransferred: initial.totalTransferred,
        issuedAt: now, expiresAt: now + 30000
      }, receiverDevice.signingPrivateKey, { now });
      const resumeFrame = encodeWireFrame({
        header: { app: APP_ID, protocolVersion: PROTOCOL_VERSION, type: MESSAGE_TYPES.TRANSFER_RESUME },
        payload: encodeTransferMessage(TYPE_TRANSFER_RESUME, signedResume, { now })
      });

      socket.write(Buffer.concat([decisionFrame, resumeFrame]), (err) => {
        if (err) { bootstrapDone.reject(err); return; }
        bootstrapDone.resolve(envelope);
      });

      // Start receiver session. The bootstrap (manifest) and the stream session
      // share the same TCP socket. The WireFrameDecoder may have leftover bytes
      // (belonging to the stream session) buffered after the manifest frame.
      // We use a Duplex bridge so the stream session can both read (socket→bridge,
      // with leftover prepended) and write (bridge→socket).
      transferCheckpoint = advanceTransferControlCheckpoint(TYPE_TRANSFER_RESUME, signedResume, { now });
      const { Duplex } = require('stream');
      const leftover = decoder.bufferedBytes > 0 ? Buffer.from(decoder.buffer) : Buffer.alloc(0);
      const bridge = new Duplex({
        read() {},
        write(chunk, _enc, cb) { socket.write(chunk, cb); }
      });
      // Feed leftover bytes first, then pipe socket data into the bridge
      if (leftover.length > 0) bridge.push(leftover);
      socket.on('data', (data) => bridge.push(data));
      socket.on('end', () => bridge.push(null));
      socket.on('error', (err) => bridge.destroy(err));
      // Find matching sender identity for the session
      const sessionSender = senderIdentities.find(id => id.deviceId === envelope.senderDeviceId);
      startReceiverSession(bridge, receiverDevice, envelope, signedResume, receiveDir, sessionDone, transferCheckpoint, sessionSender);
    } catch (error) {
      bootstrapDone.reject(error);
      sessionDone.reject(error);
    }
  };
  socket.on('data', onData);
  socket.on('error', (err) => { bootstrapDone.reject(err); sessionDone.reject(err); });

  const result = await sessionDone.promise;
  const fileEntries = result.manifest.entries.filter((e) => e.kind === 'file');
  console.log(JSON.stringify({
    type: 'RESULT', role: 'receiver', result: 'ok',
    files: fileEntries.length, bytes: result.manifest.totalBytes,
    sha256: fileEntries[0]?.sha256 || ''
  }));
  // exit after a successful transfer
  setTimeout(() => process.exit(0), 500);
}

async function startReceiverSession(socket, receiverDevice, envelope, initialResume, receiveDir, done, checkpoint, senderIdentity) {
  console.log(JSON.stringify({ type: 'DEBUG', msg: 'startReceiverSession', receiverDeviceId: receiverDevice.deviceId, senderIdentityDeviceId: senderIdentity ? senderIdentity.deviceId : null, envelopeSenderDeviceId: envelope.senderDeviceId }));
  const mHash = manifestHash(envelope.manifest);
  const sessionKey = deriveSessionKey({
    localPrivateKeyPem: receiverDevice.encryptionPrivateKey,
    remotePublicKeyPem: rawX25519PublicKeyToPem(envelope.senderEphemeralPublicKey),
    senderDeviceId: envelope.senderDeviceId,
    receiverDeviceId: receiverDevice.deviceId,
    taskId: envelope.manifest.taskId,
    manifestSha256: mHash
  });

  const plan = await planReceiveTargets({ manifest: envelope.manifest, receiveRoot: receiveDir });
  const writer = await createEncryptedChunkWriter({
    manifest: envelope.manifest, plan, sessionKey, signal: undefined
  });

  let transferCheckpoint = checkpoint;
  const control = createSignedStreamControlCodec({
    localDevice: receiverDevice,
    remotePeer: { identity: senderIdentity || { deviceId: envelope.senderDeviceId, signingPublicKey: envelope.senderSigningPublicKey } },
    taskId: envelope.manifest.taskId,
    sessionId: envelope.sessionId,
    now: () => Date.now(),
    ttlMs: 30000
  });
  console.log(JSON.stringify({ type: 'DEBUG', msg: 'codec-config', localDeviceId: receiverDevice.deviceId, remoteDeviceId: (senderIdentity||{}).deviceId || envelope.senderDeviceId, taskId: envelope.manifest.taskId, sessionId: envelope.sessionId }));

  const session = createTransferStreamSession({
    stream: socket,
    role: 'receiver',
    taskId: envelope.manifest.taskId,
    localPeerId: receiverDevice.deviceId,
    remotePeerId: envelope.senderDeviceId,
    chunkWriter: writer,
    encodeControl: control.encodeControl,
    decodeControl: control.decodeControl,
    verifyControl: control.verifyControl,
    encodeProgress: async (progress) => {
      // createEncryptedChunkWriter returns { nextSequence, files:[{path,committedOffset,completed}] }
      // but validateProgress expects flat { path, fileSize, committedOffset, completed, nextSequence, totalTransferred }
      const currentFile = progress.files && progress.files[progress.files.length - 1];
      const totalTransferred = progress.files
        ? progress.files.reduce((sum, f) => sum + f.committedOffset, 0)
        : 0;
      const flatProgress = {
        path: currentFile ? currentFile.path : '',
        fileSize: envelope.manifest.entries.find((e) => e.kind === 'file' && e.path === (currentFile ? currentFile.path : ''))?.size || 0,
        committedOffset: currentFile ? currentFile.committedOffset : 0,
        completed: currentFile ? currentFile.completed : false,
        nextSequence: progress.nextSequence,
        totalTransferred
      };
      const now = Date.now();
      const signed = signTransferMessage(TYPE_TRANSFER_PROGRESS, {
        app: APP_ID, protocolVersion: PROTOCOL_VERSION, type: TYPE_TRANSFER_PROGRESS,
        taskId: envelope.manifest.taskId,
        sessionId: envelope.sessionId,
        senderDeviceId: receiverDevice.deviceId,
        receiverDeviceId: envelope.senderDeviceId,
        manifestHash: mHash,
        ...flatProgress,
        issuedAt: now, expiresAt: now + 30000
      }, receiverDevice.signingPrivateKey, { now, checkpoint: transferCheckpoint });
      const encoded = encodeTransferMessage(TYPE_TRANSFER_PROGRESS, signed, { now, checkpoint: transferCheckpoint });
      transferCheckpoint = advanceTransferControlCheckpoint(TYPE_TRANSFER_PROGRESS, signed, { now, checkpoint: transferCheckpoint });
      return encoded;
    },
    decodeProgress: async () => { throw new Error('receiver cannot decode progress'); },
    commitProgress: async () => { throw new Error('receiver cannot commit progress'); },
    handshakeTimeoutMs: 30000,
    idleTimeoutMs: 60000,
    writeTimeoutMs: 30000,
    operationTimeoutMs: 60000,
    pauseTimeoutMs: 30000,
    closingTimeoutMs: 30000
  });

  session.start().then(async () => {
    // Verify SHA256 of received files
    const fileEntries = envelope.manifest.entries.filter((e) => e.kind === 'file');
    for (const entry of fileEntries) {
      const target = plan.targets.find((t) => t.path === entry.path);
      if (!target) throw new Error('no receive target for ' + entry.path);
      const fileBuf = fs.readFileSync(target.finalPath);
      const actualHash = crypto.createHash('sha256').update(fileBuf).digest('hex');
      if (actualHash !== entry.sha256) {
        throw new Error('SHA256 mismatch for ' + entry.path + ': expected ' + entry.sha256 + ' got ' + actualHash);
      }
    }
    done.resolve({ state: 'completed', files: fileEntries.length, manifest: envelope.manifest });
  }, done.reject);
}

// ─── Sender ────────────────────────────────────────────────────────────────

async function runSender(args) {
  const host = args.host;
  const port = parseInt(args.port, 10);
  const filePath = args.file;

  if (!host || !port || !filePath) {
    console.error('sender requires --host --port --file');
    process.exit(1);
  }

  const senderDevice = loadOrCreateDevice(args, 'Sender');
  console.log(JSON.stringify({ type: 'SENDER_IDENTITY', ...publicIdentity(senderDevice) }));

  // Build peer identity from args or from --peer-identity-file (JSON from receiver's RECEIVER_IDENTITY line)
  let peerIdentity;
  if (args['peer-identity-file']) {
    const raw = fs.readFileSync(args['peer-identity-file'], 'utf8');
    const lines = raw.split('\n');
    const idLine = lines.find((l) => l.includes('"RECEIVER_IDENTITY"')) || lines[0];
    const parsed = JSON.parse(idLine);
    peerIdentity = {
      deviceId: parsed.deviceId,
      deviceName: parsed.deviceName || 'Peer',
      fingerprint: parsed.fingerprint || '',
      signingPublicKey: parsed.signingPublicKey,
      encryptionPublicKey: parsed.encryptionPublicKey
    };
  } else {
    peerIdentity = {
      deviceId: args['peer-id'],
      deviceName: args['peer-name'] || 'Peer',
      fingerprint: args['peer-fingerprint'] || '',
      signingPublicKey: args['peer-signing'],
      encryptionPublicKey: args['peer-encryption']
    };
  }

  // Pre-seed trust
  const trustedPeer = {
    identity: peerIdentity,
    displayName: peerIdentity.deviceName,
    permissions: { transfer: true, libraryRead: false, libraryUpload: false },
    pairedAt: Date.now(),
    lastSeen: Date.now(),
    revokedAt: null,
    updatedAt: Date.now()
  };

  const trustedPeerStore = {
    getTrustedPeer: () => trustedPeer
  };

  // Build manifest from the file
  const { manifest, files: sources } = await buildTransferSourceManifest([filePath]);
  console.log(JSON.stringify({ type: 'INFO', msg: 'built manifest for ' + filePath + ' (' + manifest.totalBytes + ' bytes, ' + manifest.totalFiles + ' files)' }));

  // Stub lanService.listPeers to return the known peer endpoint
  const endpoint = {
    ...peerIdentity,
    host,
    port,
    capabilities: ['transfer'],
    lastSeen: Date.now()
  };
  const lanService = { listPeers: () => [endpoint] };

  const controller = new AbortController();
  const checkpoint = {
    files: manifest.entries.filter((e) => e.kind === 'file').map((e) => ({
      path: e.path, size: e.size, committedOffset: 0, completed: false
    })),
    totalTransferred: 0,
    nextSequence: 0
  };

  const job = {
    taskId: manifest.taskId,
    peerDeviceId: peerIdentity.deviceId,
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
  };

  const startTime = Date.now();
  console.log(JSON.stringify({ type: 'INFO', msg: 'connecting to ' + host + ':' + port + ' and starting transfer...' }));

  try {
    const executor = await createDesktopTransferExecutor({
      job,
      checkpoint,
      signal: controller.signal,
      commitRemoteCheckpoint: async (cp) => cp,
      localDevice: senderDevice,
      trustedPeerStore,
      lanService,
      connector: async () => {
        const sock = net.createConnection({ host, port });
        sock.setNoDelay(true);
        await new Promise((res, rej) => {
          sock.once('connect', res);
          sock.once('error', rej);
        });
        return sock;
      },
      clock: () => Date.now(),
      timeouts: {
        connectMs: 15000,
        bootstrapMs: 30000,
        controlTtlMs: 30000,
        handshakeMs: 30000,
        idleMs: 60000,
        writeMs: 30000,
        operationMs: 60000,
        pauseMs: 30000,
        closingMs: 30000
      }
    });

    const result = await executor.done;
    const duration = Date.now() - startTime;
    console.log(JSON.stringify({
      type: 'RESULT',
      role: 'sender',
      result: 'ok',
      state: result.state,
      durationMs: duration,
      bytes: manifest.totalBytes,
      files: manifest.totalFiles,
      sha256: manifest.entries.find((e) => e.kind === 'file')?.sha256 || ''
    }));
  } catch (error) {
    const duration = Date.now() - startTime;
    console.log(JSON.stringify({
      type: 'RESULT',
      role: 'sender',
      result: 'fail',
      error: error.message,
      code: error.code || '',
      durationMs: duration
    }));
    process.exit(1);
  }
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  const role = process.argv[2];
  const args = parseArgs(process.argv.slice(3));

  if (role === 'receiver') {
    await runReceiver(args);
    // keep process alive (server listening)
  } else if (role === 'sender') {
    await runSender(args);
  } else {
    console.error('Usage: node test/cross-machine-transfer.js [receiver|sender] --options');
    process.exit(1);
  }
}

main().catch((error) => {
  console.log(JSON.stringify({ type: 'FATAL', error: error.message, stack: error.stack }));
  process.exit(1);
});

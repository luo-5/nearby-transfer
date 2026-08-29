/**
 * Cross-machine transfer test script.
 * Run on the SENDER machine. Connects to receiver via TCP.
 *
 * Usage: node cross-transfer.mjs <receiver-ip> <file-path> <receiver-port>
 * Default receiver-port: 53118
 *
 * This script:
 * 1. Loads or creates local device identity
 * 2. Creates a TCP server to receive the manifest (acts as receiver-lite)
 * 3. OR connects to a receiver running the same script in receive mode
 *
 * For simplicity, this script does BOTH sides in one process:
 * - Sender: creates manifest, connects to receiver, sends file
 * - Receiver: must be started first with `node cross-transfer.mjs --receive <port>`
 *
 * But actually, let's just use the e2e test pattern directly.
 * The sender and receiver pre-share their public keys (no pairing needed).
 */

import { createHash, randomFillSync } from 'node:crypto';
import { writeFileSync, readFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import net from 'node:net';

import {
  createEd25519KeyPair,
  createX25519KeyPair,
  deriveDeviceId,
  buildTransferSourceManifest,
  createDesktopTransferExecutor,
  createTransferReceiver,
  JOB_DIRECTION,
  JOB_STATUS,
} from '@luo-5/core';

const mode = process.argv[2]; // 'send' or 'receive'
const arg2 = process.argv[3]; // file path (send) or receive dir (receive)
const arg3 = process.argv[4]; // receiver host (send) or port (receive)

// Device identity — persisted to ~/.nearby-transfer/cross-test-device.json
const devicePath = join(process.env.HOME || process.env.USERPROFILE || '.', '.nearby-transfer', 'cross-test-device.json');

function loadOrCreateDevice() {
  if (existsSync(devicePath)) {
    return JSON.parse(readFileSync(devicePath, 'utf8'));
  }
  const signing = createEd25519KeyPair();
  const encryption = createX25519KeyPair();
  const deviceId = deriveDeviceId(signing.publicKey);
  const device = {
    deviceId,
    signingPublicKey: signing.publicKey,
    signingPrivateKey: signing.privateKey,
    encryptionPublicKey: encryption.publicKey,
    encryptionPrivateKey: encryption.privateKey,
  };
  mkdirSync(join(process.env.HOME || process.env.USERPROFILE || '.', '.nearby-transfer'), { recursive: true });
  writeFileSync(devicePath, JSON.stringify(device, null, 2));
  return device;
}

// Trusted peers store — shared file that both sides write to
const trustPath = join(process.env.HOME || process.env.USERPROFILE || '.', '.nearby-transfer', 'cross-test-trust.json');

function loadTrust() {
  if (existsSync(trustPath)) {
    return JSON.parse(readFileSync(trustPath, 'utf8'));
  }
  return { peers: {} };
}

function saveTrust(trust) {
  mkdirSync(join(process.env.HOME || process.env.USERPROFILE || '.', '.nearby-transfer'), { recursive: true });
  writeFileSync(trustPath, JSON.stringify(trust, null, 2));
}

async function main() {
  const device = loadOrCreateDevice();
  console.log(`Device: ${device.deviceId} (${mode})`);

  if (mode === '--receive') {
    // Receiver mode: start TCP server, wait for incoming transfer
    const recvDir = arg2 || join(tmpdir(), `nt-cross-recv-${Date.now()}`);
    const port = parseInt(arg3 || '53118', 10);
    mkdirSync(recvDir, { recursive: true });

    // Register our identity in the trust file
    const trust = loadTrust();
    trust.peers[device.deviceId] = {
      signingPublicKey: device.signingPublicKey,
      encryptionPublicKey: device.encryptionPublicKey,
    };
    trust.selfDeviceId = device.deviceId;
    trust.selfSigningPrivateKey = device.signingPrivateKey;
    trust.selfEncryptionPrivateKey = device.encryptionPrivateKey;
    saveTrust(trust);
    console.log(`Receiver ready on port ${port}, recv dir: ${recvDir}`);
    console.log(`Waiting for sender to connect...`);
    console.log(`My deviceId: ${device.deviceId}`);
    console.log(`My signingPublicKey: ${device.signingPublicKey.substring(0, 40)}...`);

    const server = net.createServer((socket) => {
      socket.setNoDelay(true);
      console.log('Incoming connection!');

      // Look up the trust file to find trusted peers
      const currentTrust = loadTrust();
      const trustedPeers = new Map();
      for (const [id, info] of Object.entries(currentTrust.peers)) {
        if (id !== device.deviceId) {
          trustedPeers.set(id, { signingPublicKey: info.signingPublicKey, deviceName: 'peer' });
        }
      }

      createTransferReceiver({
        socket,
        receiveDir: recvDir,
        localDeviceId: device.deviceId,
        localSigningPrivateKey: device.signingPrivateKey,
        localEncryptionPrivateKey: device.encryptionPrivateKey,
        // Look up trusted peers from the trust file. The sender's identity
        // must be pre-registered via the trust file exchange.
        lookupPeer: (id) => trustedPeers.get(id) ?? null,
      }).then(r => r.done).then(() => {
        console.log('Transfer complete!');
        // List received files
        try {
          const files = require('node:fs').readdirSync(recvDir);
          for (const f of files) {
            const fp = join(recvDir, f);
            const hash = createHash('sha256').update(readFileSync(fp)).digest('hex');
            console.log(`  Received: ${f} (SHA-256: ${hash})`);
          }
        } catch (e) { console.error('Error listing files:', e.message); }
        socket.destroy();
        server.close();
        process.exit(0);
      }).catch(e => {
        console.error('Receiver error:', e.message);
        socket.destroy();
        server.close();
        process.exit(1);
      });
    });

    server.listen(port, '0.0.0.0', () => {
      console.log(`Listening on 0.0.0.0:${port}`);
    });

  } else if (mode === '--send') {
    // Sender mode: connect to receiver and send a file
    const filePath = arg2;
    const receiverHost = arg3 || '127.0.0.1';
    const receiverPort = parseInt(process.argv[5] || '53118', 10);

    if (!filePath || !existsSync(filePath)) {
      console.error(`File not found: ${filePath}`);
      process.exit(1);
    }

    console.log(`Sending ${filePath} to ${receiverHost}:${receiverPort}`);

    // We need the receiver's public keys. Check trust file first.
    let trust = loadTrust();
    let receiverPeer = null;

    // If trust file has a peer that's not us, use it
    for (const [id, info] of Object.entries(trust.peers || {})) {
      if (id !== device.deviceId) {
        receiverPeer = { deviceId: id, ...info };
        break;
      }
    }

    if (!receiverPeer) {
      console.error('No trusted peer found. The receiver must be started first to register its identity.');
      console.error('Run: node cross-transfer.mjs --receive <dir> <port>');
      console.error('Then copy the trust file from receiver to sender.');
      process.exit(1);
    }

    console.log(`Receiver: ${receiverPeer.deviceId}`);

    // Build manifest
    const sm = await buildTransferSourceManifest([filePath]);
    console.log(`Manifest: ${sm.manifest.taskId}, ${sm.files.length} file(s), ${sm.manifest.totalBytes} bytes`);

    const fileHash = createHash('sha256').update(readFileSync(filePath)).digest('hex');
    console.log(`Sender file SHA-256: ${fileHash}`);

    const controller = new AbortController();
    const executor = await createDesktopTransferExecutor({
      job: {
        taskId: sm.manifest.taskId,
        peerDeviceId: receiverPeer.deviceId,
        direction: JOB_DIRECTION.OUTGOING,
        status: JOB_STATUS.TRANSFERRING,
        manifest: sm.manifest,
        sources: sm.files,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        errorMessage: null,
        diagnosticCode: null,
        files: [],
        outgoingCheckpoint: null,
        localDeviceId: device.deviceId,
        signingPrivateKey: device.signingPrivateKey,
        remoteSigningPublicKey: receiverPeer.signingPublicKey,
        remoteEncryptionPublicKey: receiverPeer.encryptionPublicKey,
        peer: { host: receiverHost, port: receiverPort },
      },
      checkpoint: null,
      signal: controller.signal,
      commitRemoteCheckpoint: () => ({}),
    });

    await executor.done;
    console.log('Send complete!');
    process.exit(0);

  } else {
    console.log('Usage:');
    console.log('  Receive: node cross-transfer.mjs --receive <recv-dir> <port>');
    console.log('  Send:    node cross-transfer.mjs --send <file-path> <receiver-ip> <port>');
    process.exit(1);
  }
}

main().catch(e => {
  console.error('Fatal:', e.message);
  process.exit(1);
});

/**
 * `nearby-transfer receive --dir <directory>` — start a TCP server that
 * receives encrypted file transfers from trusted peers.
 *
 * Uses the core's createTransferReceiver to handle the full v2 protocol:
 * manifest bootstrap, session key derivation, AES-256-GCM chunk decryption,
 * and atomic file publication to the receive directory.
 */

import { parseArgs } from 'node:util';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createServer, type Socket } from 'node:net';
import { Buffer } from 'node:buffer';
import {
  V2Discovery,
  JsonTrustStore,
  ConnectionLimiter,
  createTransferReceiver,
  type TrustRecord,
} from '@luo-5/core';
import { loadOrCreateDevice, parseCommonOptions } from '../device.js';

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function rawEd25519ToPem(raw: Uint8Array): string {
  if (raw.length !== 32) throw new Error('Ed25519 public key must be 32 bytes');
  const der = Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(raw)]);
  const b64 = der.toString('base64');
  return `-----BEGIN PUBLIC KEY-----\n${b64.match(/.{1,64}/g)!.join('\n')}\n-----END PUBLIC KEY-----\n`;
}

export async function receiveCommand(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      dir: { type: 'string' },
      'data-dir': { type: 'string' },
      port: { type: 'string' },
    },
    allowPositionals: true,
  });

  if (!values.dir) {
    process.stderr.write('Error: --dir <directory> is required\n');
    process.exit(1);
  }

  const opts = parseCommonOptions(args);
  const receiveDir = resolve(values.dir);
  mkdirSync(receiveDir, { recursive: true });

  const device = loadOrCreateDevice(opts.dataDir);
  const dataDir = opts.dataDir ?? undefined;
  const trustStore = new JsonTrustStore(dataDir ?? `${process.env.HOME ?? process.env.USERPROFILE ?? '.'}/.nearby-transfer`);

  const initialTrustedPeers = trustStore.loadSync();
  const lookupPeer = createLiveTrustLookup(trustStore);

  process.stdout.write(`Receiving files into: ${receiveDir}\n`);
  process.stdout.write(`Device: ${device.deviceName} (${device.deviceId})\n`);
  process.stdout.write(`Fingerprint: ${device.fingerprint}\n`);
  process.stdout.write(`Trusted peers: ${initialTrustedPeers.length}\n\n`);

  // Create the TCP server
  const connectionLimiter = new ConnectionLimiter({ maxGlobalConnections: 16, maxPerIpConnections: 4 });
  const activeSockets = new Set<Socket>();
  const activeReceivers = new Set<Promise<void>>();
  const server = createServer(async (socket: Socket) => {
    const remoteAddr = `${socket.remoteAddress}:${socket.remotePort}`;
    const lease = connectionLimiter.acquire(socket.remoteAddress ?? 'unknown');
    if (!lease) {
      process.stderr.write(`[reject] Connection limit reached for ${remoteAddr}\n`);
      socket.destroy();
      return;
    }
    activeSockets.add(socket);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      activeSockets.delete(socket);
      lease.release();
    };
    socket.once('close', release);
    socket.setTimeout(15_000, () => socket.destroy(new Error('Unauthenticated connection timed out')));
    process.stdout.write(`\n[connect] ${remoteAddr}\n`);
    try {
      const receiver = await createTransferReceiver({
        socket,
        receiveDir,
        localDeviceId: device.deviceId,
        localSigningPrivateKey: device.signingPrivateKey,
        localEncryptionPrivateKey: device.encryptionPrivateKey,
        lookupPeer,
      });
      socket.setTimeout(0);

      const receiverDone = receiver.done.then(() => {
        process.stdout.write(`[done] Transfer completed from ${remoteAddr}\n`);
      }).catch((error: Error) => {
        process.stderr.write(`[error] Transfer failed from ${remoteAddr}: ${error.message}\n`);
      }).finally(() => {
        socket.destroy();
        activeReceivers.delete(receiverDone);
      });
      activeReceivers.add(receiverDone);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[error] Receiver setup failed from ${remoteAddr}: ${msg}\n`);
      socket.destroy();
    }
  });

  const listenPort = opts.port ?? 0;
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once('error', onError);
    server.listen(listenPort, '0.0.0.0', () => {
      server.off('error', onError);
      resolve();
    });
  });
  server.on('error', (error: Error) => {
    process.stderr.write(`Server error: ${error.message}\n`);
  });
  const actualPort = (server.address() as { port: number }).port;

  // Start discovery so other devices can find us
  const discovery = new V2Discovery({
    device,
    port: actualPort,
    capabilities: ['pairing', 'transfer'],
  });

  discovery.on('peer', (peer) => {
    process.stdout.write(`[discover] ${peer.deviceName} (${peer.deviceId}) at ${peer.host}:${peer.port}\n`);
  });
  discovery.on('error', (error: Error) => {
    process.stderr.write(`Discovery error: ${error.message}\n`);
  });
  discovery.start();

  process.stdout.write(`Listening on port ${actualPort}...\n`);
  process.stdout.write('Waiting for incoming transfers (Ctrl+C to stop)\n\n');

  let resolveShutdown!: () => void;
  const shutdownComplete = new Promise<void>((resolve) => { resolveShutdown = resolve; });
  let shutdownPromise: Promise<void> | null = null;
  const shutdown = () => {
    if (shutdownPromise) return shutdownPromise;
    process.stdout.write('\nStopping...\n');
    discovery.stop();
    for (const socket of activeSockets) socket.destroy();
    shutdownPromise = Promise.allSettled(Array.from(activeReceivers))
      .then(() => closeNetServer(server))
      .finally(() => {
        connectionLimiter.clear();
        resolveShutdown();
      });
    return shutdownPromise;
  };
  const onSignal = () => {
    void shutdown();
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  await shutdownComplete;
  process.off('SIGINT', onSignal);
  process.off('SIGTERM', onSignal);
  await shutdown();
}

function closeNetServer(server: ReturnType<typeof createServer>): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

export function createLiveTrustLookup(trustStore: JsonTrustStore) {
  return (deviceId: string): { signingPublicKey: string; deviceName?: string } | null => {
    const peer = trustStore.loadSync().find((record) => record.deviceId === deviceId);
    if (!peer) return null;
    return {
      signingPublicKey: rawEd25519ToPem(peer.signingPublicKey),
      deviceName: peer.name,
    };
  };
}

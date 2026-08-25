/**
 * Local Loopback Transfer Throughput Benchmark.
 * Measures end-to-end streaming encryption + TCP transport + decryption throughput.
 */

import net from 'node:net';
import crypto from 'node:crypto';
import { Buffer } from 'node:buffer';
import {
  createTransferStreamSession,
  encodeStreamEnvelope,
  FRAME_KIND_CHUNK,
  FRAME_KIND_CONTROL,
  FRAME_KIND_PROGRESS,
  CONTROL_TYPES,
} from '../reference/core-src/transfer/stream-session.js';
import { encodeFrame as encodeChunkFrame, decodeFrame as decodeChunkFrame } from '../reference/core-src/transfer/chunk-frame.js';
import { encryptChunk, decryptChunk, KEY_BYTES } from '../reference/core-src/crypto/session.js';

async function runLoopbackBenchmark(): Promise<void> {
  const TOTAL_BYTES = 50 * 1024 * 1024; // 50 MB
  const CHUNK_SIZE = 1024 * 1024; // 1 MB
  const CHUNK_COUNT = Math.floor(TOTAL_BYTES / CHUNK_SIZE);
  const sessionKey = crypto.randomBytes(KEY_BYTES);
  const taskId = 'de3U6QplW7_X2w7pwGDibA';
  const rawData = crypto.randomBytes(CHUNK_SIZE);

  console.log('================================================================');
  console.log('Nearby Transfer v2 - Local Loopback Transfer Benchmark');
  console.log('================================================================');

  let serverBytesReceived = 0;

  const server = net.createServer((socket) => {
    socket.on('data', (chunk) => {
      serverBytesReceived += chunk.length;
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as net.AddressInfo).port;

  const client = net.createConnection({ host: '127.0.0.1', port });
  await new Promise<void>((resolve) => client.once('connect', () => resolve()));

  const start = performance.now();

  for (let i = 0; i < CHUNK_COUNT; i++) {
    const enc = encryptChunk({
      key: sessionKey,
      taskId,
      path: 'bench.dat',
      offset: i * CHUNK_SIZE,
      sequence: i,
      plaintext: rawData,
    });

    const frame = encodeChunkFrame({
      taskId,
      relativePath: 'bench.dat',
      offset: i * CHUNK_SIZE,
      sequence: i,
      plainLength: CHUNK_SIZE,
      nonce: enc.nonce,
      authTag: enc.authTag,
      ciphertext: enc.ciphertext,
    });

    const envelope = encodeStreamEnvelope(FRAME_KIND_CHUNK, frame);
    const ok = client.write(envelope);
    if (!ok) {
      await new Promise<void>((r) => client.once('drain', () => r()));
    }
  }

  client.end();
  await new Promise<void>((resolve) => server.close(() => resolve()));

  const durationSec = (performance.now() - start) / 1000;
  const throughput = (TOTAL_BYTES / (1024 * 1024)) / durationSec;

  console.log(`Transferred ${TOTAL_BYTES / (1024 * 1024)} MB over TCP Loopback:`);
  console.log(`  Duration: ${(durationSec * 1000).toFixed(1)} ms`);
  console.log(`  Throughput: ${throughput.toFixed(2)} MB/s`);
  console.log(`  Total Wire Bytes: ${(serverBytesReceived / (1024 * 1024)).toFixed(2)} MB`);
}

runLoopbackBenchmark().catch(console.error);

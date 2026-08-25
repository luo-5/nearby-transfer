/**
 * Crypto Throughput Benchmark (AES-256-GCM + AAD).
 * Measures encryption and decryption speed in MB/s.
 */

import crypto from 'node:crypto';
import { Buffer } from 'node:buffer';
import { encryptChunk, decryptChunk, KEY_BYTES } from '../reference/core-src/crypto/session.js';

async function runCryptoBenchmark(): Promise<void> {
  const CHUNK_SIZES = [64 * 1024, 256 * 1024, 1024 * 1024]; // 64 KiB, 256 KiB, 1 MiB
  const TOTAL_DATA_BYTES = 100 * 1024 * 1024; // 100 MiB total data processed per test
  const key = crypto.randomBytes(KEY_BYTES);
  const taskId = 'de3U6QplW7_X2w7pwGDibA';

  console.log('================================================================');
  console.log('Nearby Transfer v2 - AES-256-GCM Crypto Throughput Benchmark');
  console.log('================================================================');

  for (const chunkSize of CHUNK_SIZES) {
    const chunkCount = Math.floor(TOTAL_DATA_BYTES / chunkSize);
    const plaintext = crypto.randomBytes(chunkSize);
    const label = `${(chunkSize / (1024 * 1024)).toFixed(2)} MB chunk`;

    // 1. Warm-up
    for (let i = 0; i < 5; i++) {
      encryptChunk({ key, taskId, path: 'bench.bin', offset: 0, sequence: 0, plaintext });
    }

    // 2. Encryption Benchmark
    const startEnc = performance.now();
    const encryptedChunks = [];
    for (let i = 0; i < chunkCount; i++) {
      encryptedChunks.push(
        encryptChunk({
          key,
          taskId,
          path: 'bench.bin',
          offset: i * chunkSize,
          sequence: i,
          plaintext,
        }),
      );
    }
    const endEnc = performance.now();
    const encDurationSec = (endEnc - startEnc) / 1000;
    const encThroughput = (TOTAL_DATA_BYTES / (1024 * 1024)) / encDurationSec;

    // 3. Decryption Benchmark
    const startDec = performance.now();
    for (let i = 0; i < chunkCount; i++) {
      const enc = encryptedChunks[i]!;
      decryptChunk({
        key,
        nonce: enc.nonce,
        taskId,
        path: 'bench.bin',
        offset: i * chunkSize,
        sequence: i,
        plainLength: chunkSize,
        ciphertext: enc.ciphertext,
        authTag: enc.authTag,
      });
    }
    const endDec = performance.now();
    const decDurationSec = (endDec - startDec) / 1000;
    const decThroughput = (TOTAL_DATA_BYTES / (1024 * 1024)) / decDurationSec;

    console.log(`[Chunk: ${label}]`);
    console.log(`  Encrypt Speed: ${encThroughput.toFixed(2)} MB/s (${(encDurationSec * 1000).toFixed(1)} ms for 100 MB)`);
    console.log(`  Decrypt Speed: ${decThroughput.toFixed(2)} MB/s (${(decDurationSec * 1000).toFixed(1)} ms for 100 MB)`);
  }
}

runCryptoBenchmark().catch(console.error);

/**
 * Canonical JSON Serialization Benchmark.
 * Measures serialization latency in microseconds per operation (μs/op).
 */

import { canonicalJson, parseCanonicalJson } from '../packages/core/src/canonical-json.js';
import { optimizedCanonicalJson } from '../packages/core/src/optimizations/optimized-canonical-json.js';

function runSerializationBenchmark(): void {
  const SAMPLES = 50000;

  const smallObj = {
    app: 'nearby-transfer',
    protocolVersion: 2,
    type: 'stream-hello',
    taskId: 'de3U6QplW7_X2w7pwGDibA',
    sessionId: 'session_1234567890abcdef',
    fromPeerId: '45c50cb5ae48c0f6',
    toPeerId: 'a2bf86faa1298f7a',
  };

  const manifestObj = {
    app: 'nearby-transfer',
    protocolVersion: 2,
    type: 'transfer-manifest',
    taskId: 'de3U6QplW7_X2w7pwGDibA',
    conflictStrategy: 'auto-rename',
    entries: Array.from({ length: 50 }, (_, i) => ({
      kind: 'file' as const,
      path: `docs/file_${i}.txt`,
      size: 1024 * i,
      sha256: 'a'.repeat(64),
    })),
    totalFiles: 50,
    totalBytes: 1250000,
  };

  console.log('================================================================');
  console.log('Nearby Transfer v2 - Canonical JSON Serialization Benchmark');
  console.log('================================================================');

  // 1. Small Object - Baseline
  let start = performance.now();
  for (let i = 0; i < SAMPLES; i++) {
    canonicalJson(smallObj);
  }
  let durationMs = performance.now() - start;
  let usPerOp = (durationMs * 1000) / SAMPLES;
  console.log(`Small Control Message (${SAMPLES} ops):`);
  console.log(`  Standard canonicalJson:  ${usPerOp.toFixed(3)} μs/op (${((SAMPLES / durationMs) * 1000).toFixed(0)} ops/sec)`);

  // 2. Small Object - Optimized
  start = performance.now();
  for (let i = 0; i < SAMPLES; i++) {
    optimizedCanonicalJson(smallObj);
  }
  durationMs = performance.now() - start;
  usPerOp = (durationMs * 1000) / SAMPLES;
  console.log(`  Optimized canonicalJson: ${usPerOp.toFixed(3)} μs/op (${((SAMPLES / durationMs) * 1000).toFixed(0)} ops/sec)\n`);

  // 3. Manifest Object (50 entries) - Baseline
  start = performance.now();
  for (let i = 0; i < 5000; i++) {
    canonicalJson(manifestObj);
  }
  durationMs = performance.now() - start;
  usPerOp = (durationMs * 1000) / 5000;
  console.log(`50-Entry Manifest (5,000 ops):`);
  console.log(`  Standard canonicalJson:  ${usPerOp.toFixed(3)} μs/op (${((5000 / durationMs) * 1000).toFixed(0)} ops/sec)`);

  // 4. Manifest Object (50 entries) - Optimized
  start = performance.now();
  for (let i = 0; i < 5000; i++) {
    optimizedCanonicalJson(manifestObj);
  }
  durationMs = performance.now() - start;
  usPerOp = (durationMs * 1000) / 5000;
  console.log(`  Optimized canonicalJson: ${usPerOp.toFixed(3)} μs/op (${((5000 / durationMs) * 1000).toFixed(0)} ops/sec)`);
}

runSerializationBenchmark();

/**
 * Optimized Chunk AAD Builder.
 * Precomputes static field prefixes (CONTEXT + CHUNK_AAD_LABEL + taskId + path)
 * and mutates only (offset, sequence, plainLength) in place to eliminate all
 * per-chunk Buffer allocations during large file transfers.
 */

import { Buffer } from 'node:buffer';
import { CONTEXT, CHUNK_AAD_LABEL, type ChunkMetadata } from '../crypto/session.js';

export class OptimizedChunkAadTemplate {
  private staticPrefix: Buffer;
  private aadBuffer: Buffer;
  private prefixLength: number;

  constructor(taskId: string, path: string) {
    const fields = [CONTEXT, CHUNK_AAD_LABEL, taskId, path];
    const chunks: Buffer[] = [];
    for (const field of fields) {
      const b = Buffer.from(field, 'utf8');
      const lenBuf = Buffer.alloc(4);
      lenBuf.writeUInt32BE(b.length, 0);
      chunks.push(lenBuf, b);
    }
    this.staticPrefix = Buffer.concat(chunks);
    this.prefixLength = this.staticPrefix.length;

    // Total length = prefixLength + 8 (offset) + 8 (sequence) + 4 (plainLength) = prefixLength + 20
    this.aadBuffer = Buffer.allocUnsafe(this.prefixLength + 20);
    this.staticPrefix.copy(this.aadBuffer, 0);
  }

  build(offset: number, sequence: number, plainLength: number): Buffer {
    let pos = this.prefixLength;
    this.aadBuffer.writeBigUInt64BE(BigInt(offset), pos);
    pos += 8;
    this.aadBuffer.writeBigUInt64BE(BigInt(sequence), pos);
    pos += 8;
    this.aadBuffer.writeUInt32BE(plainLength, pos);

    // Return a slice or cloned view
    return this.aadBuffer;
  }
}

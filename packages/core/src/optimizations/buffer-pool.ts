/**
 * High-performance Buffer Object Pool for 64 KiB / 1 MiB chunk allocations.
 * Reuses Buffer memory to minimize V8 Garbage Collection pauses during multi-gigabyte transfers.
 */

import { Buffer } from 'node:buffer';

export class BufferPool {
  readonly bufferSize: number;
  readonly maxPooled: number;
  private pool: Buffer[] = [];

  constructor(bufferSize: number = 1024 * 1024, maxPooled: number = 16) {
    this.bufferSize = bufferSize;
    this.maxPooled = maxPooled;
  }

  acquire(): Buffer {
    if (this.pool.length > 0) {
      return this.pool.pop()!;
    }
    return Buffer.allocUnsafe(this.bufferSize);
  }

  release(buffer: Buffer): boolean {
    if (buffer.length !== this.bufferSize || this.pool.length >= this.maxPooled) {
      return false;
    }
    this.pool.push(buffer);
    return true;
  }

  clear(): void {
    this.pool = [];
  }

  get available(): number {
    return this.pool.length;
  }
}

export const default1MBChunkPool = new BufferPool(1024 * 1024, 32);
export const default64KBBufferPool = new BufferPool(64 * 1024, 64);

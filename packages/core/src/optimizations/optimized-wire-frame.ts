/**
 * Optimized Wire Frame Decoder using a reusable Ring Buffer / Sliding Window
 * to eliminate O(N^2) Buffer.concat allocations during fragmented TCP chunk arrival.
 */

import { Buffer } from 'node:buffer';
import {
  decodeWireFrame,
  FRAME_LENGTH_BYTES,
  HEADER_LENGTH_BYTES,
  MAX_FRAME_SIZE,
  type WireFrame,
} from '../transfer/wire-frame.js';

export class OptimizedWireFrameDecoder {
  private buffer: Buffer;
  private writePos = 0;
  private readPos = 0;

  constructor(capacity = 64 * 1024) {
    this.buffer = Buffer.allocUnsafe(capacity);
  }

  get bufferedBytes(): number {
    return this.writePos - this.readPos;
  }

  push(chunk: Uint8Array): WireFrame[] {
    const frames: WireFrame[] = [];
    this.ensureWriteCapacity(chunk.length);

    Buffer.from(chunk).copy(this.buffer, this.writePos);
    this.writePos += chunk.length;

    while (this.bufferedBytes >= FRAME_LENGTH_BYTES) {
      const frameLength = this.buffer.readUInt32BE(this.readPos);
      if (frameLength < HEADER_LENGTH_BYTES || frameLength > MAX_FRAME_SIZE) {
        throw new RangeError(`Wire frame length must be between ${HEADER_LENGTH_BYTES} and ${MAX_FRAME_SIZE} bytes`);
      }

      const totalFrameBytes = FRAME_LENGTH_BYTES + frameLength;
      if (this.bufferedBytes < totalFrameBytes) {
        break; // Await remaining bytes
      }

      const frameSlice = this.buffer.subarray(this.readPos, this.readPos + totalFrameBytes);
      frames.push(decodeWireFrame(frameSlice));
      this.readPos += totalFrameBytes;
    }

    this.compactIfNeeded();
    return frames;
  }

  private ensureWriteCapacity(needed: number): void {
    if (this.writePos + needed <= this.buffer.length) return;

    // First try compacting unread data to the beginning
    this.compact();
    if (this.writePos + needed <= this.buffer.length) return;

    // Otherwise grow the buffer
    let nextCap = this.buffer.length * 2;
    while (nextCap < this.writePos + needed) nextCap *= 2;
    const newBuf = Buffer.allocUnsafe(nextCap);
    this.buffer.copy(newBuf, 0, this.readPos, this.writePos);
    this.writePos = this.bufferedBytes;
    this.readPos = 0;
    this.buffer = newBuf;
  }

  private compact(): void {
    if (this.readPos === 0) return;
    if (this.readPos === this.writePos) {
      this.readPos = 0;
      this.writePos = 0;
      return;
    }
    this.buffer.copy(this.buffer, 0, this.readPos, this.writePos);
    this.writePos = this.bufferedBytes;
    this.readPos = 0;
  }

  private compactIfNeeded(): void {
    if (this.readPos > 0 && this.bufferedBytes === 0) {
      this.readPos = 0;
      this.writePos = 0;
    } else if (this.readPos > 32 * 1024 && this.readPos > this.bufferedBytes) {
      this.compact();
    }
  }

  finish(): void {
    if (this.bufferedBytes !== 0) {
      throw new RangeError(`Wire frame stream ended with truncated bytes (${this.bufferedBytes})`);
    }
  }
}

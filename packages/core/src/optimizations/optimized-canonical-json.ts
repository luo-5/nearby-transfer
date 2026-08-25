/**
 * Optimized Canonical JSON Serializer.
 * Reduces memory allocations and GC overhead by streaming directly into a preallocated Buffer.
 */

import { Buffer } from 'node:buffer';
import type { CanonicalValue } from '../canonical-json.js';

export class OptimizedCanonicalJsonWriter {
  private buffer: Buffer;
  private offset = 0;

  constructor(initialCapacity = 4096) {
    this.buffer = Buffer.allocUnsafe(initialCapacity);
  }

  serialize(value: CanonicalValue): string {
    this.offset = 0;
    this.writeVal(value, '$');
    return this.buffer.toString('utf8', 0, this.offset);
  }

  serializeToBuffer(value: CanonicalValue): Buffer {
    this.offset = 0;
    this.writeVal(value, '$');
    return Buffer.from(this.buffer.subarray(0, this.offset));
  }

  private ensureCapacity(needed: number): void {
    if (this.offset + needed <= this.buffer.length) return;
    let newCap = this.buffer.length * 2;
    while (newCap < this.offset + needed) newCap *= 2;
    const nextBuf = Buffer.allocUnsafe(newCap);
    this.buffer.copy(nextBuf, 0, 0, this.offset);
    this.buffer = nextBuf;
  }

  private writeAscii(str: string): void {
    this.ensureCapacity(str.length);
    this.offset += this.buffer.write(str, this.offset, 'ascii');
  }

  private writeUtf8(str: string): void {
    const maxBytes = Buffer.byteLength(str, 'utf8');
    this.ensureCapacity(maxBytes);
    this.offset += this.buffer.write(str, this.offset, 'utf8');
  }

  private writeVal(value: CanonicalValue, path: string): void {
    if (value === null) {
      this.writeAscii('null');
      return;
    }

    if (typeof value === 'boolean') {
      this.writeAscii(value ? 'true' : 'false');
      return;
    }

    if (typeof value === 'number') {
      if (!Number.isSafeInteger(value)) {
        throw new TypeError(`Protocol value at ${path} must be a safe integer`);
      }
      this.writeAscii(String(value));
      return;
    }

    if (typeof value === 'string') {
      if (!value.isWellFormed()) {
        throw new TypeError(`Protocol string at ${path} contains an unpaired surrogate`);
      }
      this.writeUtf8(JSON.stringify(value));
      return;
    }

    if (Array.isArray(value)) {
      this.writeAscii('[');
      for (let i = 0; i < value.length; i++) {
        if (i > 0) this.writeAscii(',');
        this.writeVal(value[i] as CanonicalValue, `${path}[${i}]`);
      }
      this.writeAscii(']');
      return;
    }

    if (typeof value === 'object') {
      if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
        throw new TypeError(`Protocol value at ${path} must be a plain object`);
      }
      this.writeAscii('{');
      const keys = Object.keys(value).sort();
      for (let i = 0; i < keys.length; i++) {
        const k = keys[i]!;
        if (i > 0) this.writeAscii(',');
        this.writeUtf8(JSON.stringify(k));
        this.writeAscii(':');
        const entry = (value as Record<string, CanonicalValue>)[k];
        if (entry === undefined) {
          throw new TypeError(`Protocol value at ${path}.${k} is undefined`);
        }
        this.writeVal(entry, `${path}.${k}`);
      }
      this.writeAscii('}');
      return;
    }

    throw new TypeError(`Protocol value at ${path} has an unsupported type`);
  }
}

const defaultWriter = new OptimizedCanonicalJsonWriter(8192);

export function optimizedCanonicalJson(value: CanonicalValue): string {
  return defaultWriter.serialize(value);
}

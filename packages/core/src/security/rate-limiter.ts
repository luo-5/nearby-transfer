/**
 * Sliding window rate limiter for connection handshakes and packet processing.
 * Prevents flood DoS attacks by restricting events per key (e.g. IP address)
 * within a configurable time window.
 */

export interface RateLimiterOptions {
  windowMs?: number;
  maxRequests?: number;
  cleanupIntervalMs?: number;
}

interface WindowBucket {
  timestamps: number[];
}

export class SlidingWindowRateLimiter {
  readonly windowMs: number;
  readonly maxRequests: number;
  private buckets = new Map<string, WindowBucket>();
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor(options: RateLimiterOptions = {}) {
    this.windowMs = options.windowMs ?? 1000;
    this.maxRequests = options.maxRequests ?? 10;
    const cleanupInterval = options.cleanupIntervalMs ?? 30000;

    if (this.windowMs <= 0) throw new TypeError('windowMs must be a positive integer');
    if (this.maxRequests <= 0) throw new TypeError('maxRequests must be a positive integer');

    if (typeof setInterval !== 'undefined' && cleanupInterval > 0) {
      this.cleanupTimer = setInterval(() => this.cleanup(), cleanupInterval);
      if (this.cleanupTimer.unref) this.cleanupTimer.unref();
    }
  }

  tryAcquire(key: string, count: number = 1, now: number = Date.now()): boolean {
    if (!key) return false;
    if (count <= 0) return true;

    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { timestamps: [] };
      this.buckets.set(key, bucket);
    }

    const windowStart = now - this.windowMs;
    // Discard expired timestamps
    while (bucket.timestamps.length > 0 && bucket.timestamps[0]! <= windowStart) {
      bucket.timestamps.shift();
    }

    if (bucket.timestamps.length + count > this.maxRequests) {
      return false;
    }

    for (let i = 0; i < count; i++) {
      bucket.timestamps.push(now);
    }
    return true;
  }

  getRemaining(key: string, now: number = Date.now()): number {
    const bucket = this.buckets.get(key);
    if (!bucket) return this.maxRequests;

    const windowStart = now - this.windowMs;
    let validCount = 0;
    for (const t of bucket.timestamps) {
      if (t > windowStart) validCount++;
    }
    return Math.max(0, this.maxRequests - validCount);
  }

  reset(key?: string): void {
    if (key) {
      this.buckets.delete(key);
    } else {
      this.buckets.clear();
    }
  }

  cleanup(now: number = Date.now()): void {
    const windowStart = now - this.windowMs;
    for (const [key, bucket] of this.buckets) {
      while (bucket.timestamps.length > 0 && bucket.timestamps[0]! <= windowStart) {
        bucket.timestamps.shift();
      }
      if (bucket.timestamps.length === 0) {
        this.buckets.delete(key);
      }
    }
  }

  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.buckets.clear();
  }
}

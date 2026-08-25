/**
 * Concurrent connection limiter for TCP/Transport layers.
 * Limits both global active connections and per-remote-IP concurrent connections.
 */

export interface ConnectionLimiterOptions {
  maxGlobalConnections?: number;
  maxPerIpConnections?: number;
}

export interface ConnectionLease {
  remoteAddress: string;
  release: () => boolean;
}

export class ConnectionLimiter {
  readonly maxGlobalConnections: number;
  readonly maxPerIpConnections: number;
  private currentGlobalCount = 0;
  private countsByIp = new Map<string, number>();

  constructor(options: ConnectionLimiterOptions = {}) {
    this.maxGlobalConnections = options.maxGlobalConnections ?? 16;
    this.maxPerIpConnections = options.maxPerIpConnections ?? 4;

    if (this.maxGlobalConnections <= 0) throw new TypeError('maxGlobalConnections must be positive');
    if (this.maxPerIpConnections <= 0) throw new TypeError('maxPerIpConnections must be positive');
  }

  tryAcquire(remoteAddress: string): boolean {
    const ip = remoteAddress || 'unknown';
    if (this.currentGlobalCount >= this.maxGlobalConnections) {
      return false;
    }
    const ipCount = this.countsByIp.get(ip) || 0;
    if (ipCount >= this.maxPerIpConnections) {
      return false;
    }

    this.currentGlobalCount++;
    this.countsByIp.set(ip, ipCount + 1);
    return true;
  }

  acquire(remoteAddress: string): ConnectionLease | null {
    if (!this.tryAcquire(remoteAddress)) {
      return null;
    }

    let released = false;
    const ip = remoteAddress || 'unknown';
    return {
      remoteAddress: ip,
      release: () => {
        if (released) return false;
        released = true;
        this.release(ip);
        return true;
      },
    };
  }

  release(remoteAddress: string): void {
    const ip = remoteAddress || 'unknown';
    const ipCount = this.countsByIp.get(ip);
    if (ipCount !== undefined && ipCount > 0) {
      if (ipCount === 1) {
        this.countsByIp.delete(ip);
      } else {
        this.countsByIp.set(ip, ipCount - 1);
      }
      this.currentGlobalCount = Math.max(0, this.currentGlobalCount - 1);
    }
  }

  getGlobalCount(): number {
    return this.currentGlobalCount;
  }

  getIpCount(remoteAddress: string): number {
    return this.countsByIp.get(remoteAddress || 'unknown') || 0;
  }

  clear(): void {
    this.currentGlobalCount = 0;
    this.countsByIp.clear();
  }
}

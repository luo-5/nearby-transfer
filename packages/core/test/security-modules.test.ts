import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SlidingWindowRateLimiter } from '../src/security/rate-limiter.js';
import { ConnectionLimiter } from '../src/security/connection-limiter.js';
import { safeJsonParse } from '../src/security/safe-json-parse.js';

describe('SlidingWindowRateLimiter', () => {
  it('allows requests within rate limit', () => {
    const limiter = new SlidingWindowRateLimiter({ windowMs: 1000, maxRequests: 5 });
    const now = 10000;
    for (let i = 0; i < 5; i++) {
      assert.equal(limiter.tryAcquire('192.168.1.10', 1, now + i * 10), true);
    }
    assert.equal(limiter.tryAcquire('192.168.1.10', 1, now + 100), false);
    assert.equal(limiter.getRemaining('192.168.1.10', now + 100), 0);
  });

  it('slides window and frees capacity over time', () => {
    const limiter = new SlidingWindowRateLimiter({ windowMs: 1000, maxRequests: 2 });
    const t0 = 10000;
    assert.equal(limiter.tryAcquire('ip1', 1, t0), true);
    assert.equal(limiter.tryAcquire('ip1', 1, t0 + 100), true);
    assert.equal(limiter.tryAcquire('ip1', 1, t0 + 200), false);

    // After 1001 ms, first request expires
    assert.equal(limiter.tryAcquire('ip1', 1, t0 + 1050), true);
    // Second request is still active until t0 + 1100
    assert.equal(limiter.tryAcquire('ip1', 1, t0 + 1060), false);
    // After t0 + 1150, second request also expires
    assert.equal(limiter.tryAcquire('ip1', 1, t0 + 1150), true);
  });

  it('isolates different keys', () => {
    const limiter = new SlidingWindowRateLimiter({ windowMs: 1000, maxRequests: 1 });
    assert.equal(limiter.tryAcquire('user1', 1, 1000), true);
    assert.equal(limiter.tryAcquire('user1', 1, 1000), false);
    assert.equal(limiter.tryAcquire('user2', 1, 1000), true);
  });
});

describe('ConnectionLimiter', () => {
  it('enforces global and per-ip limits', () => {
    const limiter = new ConnectionLimiter({ maxGlobalConnections: 3, maxPerIpConnections: 2 });

    assert.equal(limiter.tryAcquire('10.0.0.1'), true);
    assert.equal(limiter.tryAcquire('10.0.0.1'), true);
    // Reached per-ip limit (2)
    assert.equal(limiter.tryAcquire('10.0.0.1'), false);

    // Another IP can connect
    assert.equal(limiter.tryAcquire('10.0.0.2'), true);
    // Reached global limit (3)
    assert.equal(limiter.tryAcquire('10.0.0.3'), false);

    // Release one
    limiter.release('10.0.0.1');
    assert.equal(limiter.getIpCount('10.0.0.1'), 1);
    assert.equal(limiter.getGlobalCount(), 2);

    // Now 10.0.0.3 can connect
    assert.equal(limiter.tryAcquire('10.0.0.3'), true);
  });

  it('supports lease object acquire/release', () => {
    const limiter = new ConnectionLimiter({ maxGlobalConnections: 1, maxPerIpConnections: 1 });
    const lease = limiter.acquire('1.2.3.4');
    assert.ok(lease);
    assert.equal(limiter.tryAcquire('1.2.3.4'), false);

    assert.equal(lease.release(), true);
    // Subsequent release calls are idempotent
    assert.equal(lease.release(), false);

    assert.equal(limiter.getGlobalCount(), 0);
  });
});

describe('safeJsonParse', () => {
  it('parses valid JSON within limits', () => {
    const json = '{"name":"alice","age":30,"items":[1,2,3]}';
    const result = safeJsonParse(json) as Record<string, unknown>;
    assert.equal(result.name, 'alice');
    assert.equal(result.age, 30);
  });

  it('rejects excessive depth', () => {
    // 5 levels deep
    const deep = '[[[[[1]]]]]';
    assert.throws(() => safeJsonParse(deep, { maxDepth: 3 }), /depth/i);
    assert.doesNotThrow(() => safeJsonParse(deep, { maxDepth: 6 }));
  });

  it('rejects keys exceeding maximum length', () => {
    const longKey = 'a'.repeat(300);
    const json = `{"${longKey}": 123}`;
    assert.throws(() => safeJsonParse(json, { maxKeyLength: 256 }), /key/i);
  });

  it('rejects prototype pollution keys', () => {
    assert.throws(() => safeJsonParse('{"__proto__": {"admin": true}}'), /prototype/i);
    assert.throws(() => safeJsonParse('{"constructor": {"admin": true}}'), /prototype/i);
    assert.throws(() => safeJsonParse('{"prototype": {"admin": true}}'), /prototype/i);
  });

  it('rejects excessive string value length', () => {
    const longVal = 'x'.repeat(1000);
    const json = `{"data": "${longVal}"}`;
    assert.throws(() => safeJsonParse(json, { maxStringLength: 500 }), /string/i);
  });
});

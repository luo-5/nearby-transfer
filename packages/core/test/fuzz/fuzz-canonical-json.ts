import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJson, parseCanonicalJson, type CanonicalValue } from '../../src/canonical-json.js';

function randomString(len: number): string {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 _-!@#$%^&*()';
  let res = '';
  for (let i = 0; i < len; i++) res += chars[Math.floor(Math.random() * chars.length)];
  return res;
}

function randomCanonicalValue(depth: number = 0): CanonicalValue {
  if (depth > 4) {
    const primitives = [null, true, false, Math.floor(Math.random() * 1000000) - 500000, randomString(10)];
    return primitives[Math.floor(Math.random() * primitives.length)] as CanonicalValue;
  }

  const choice = Math.floor(Math.random() * 6);
  switch (choice) {
    case 0: return null;
    case 1: return Math.random() > 0.5;
    case 2: return Math.floor(Math.random() * 2000000) - 1000000;
    case 3: return randomString(Math.floor(Math.random() * 20));
    case 4: {
      const arrLen = Math.floor(Math.random() * 5);
      const arr: CanonicalValue[] = [];
      for (let i = 0; i < arrLen; i++) arr.push(randomCanonicalValue(depth + 1));
      return arr;
    }
    case 5: {
      const objLen = Math.floor(Math.random() * 5);
      const obj: Record<string, CanonicalValue> = {};
      for (let i = 0; i < objLen; i++) {
        const key = 'key_' + randomString(6);
        obj[key] = randomCanonicalValue(depth + 1);
      }
      return obj;
    }
    default: return null;
  }
}

describe('fuzz-canonical-json', () => {
  it('passes 1,000 randomized round-trip and idempotency trials', () => {
    const TRIALS = 1000;
    for (let i = 0; i < TRIALS; i++) {
      const original = randomCanonicalValue();
      const serialized = canonicalJson(original);
      const parsed = parseCanonicalJson(serialized);
      const reSerialized = canonicalJson(parsed);

      assert.equal(reSerialized, serialized, `Mismatch on trial ${i}`);
    }
  });
});

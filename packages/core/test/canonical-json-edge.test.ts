import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJson, parseCanonicalJson } from '../src/canonical-json.js';

describe('canonical-json edge tests', () => {
  it('rejects numbers exceeding safe integer range', () => {
    assert.throws(() => canonicalJson(Number.MAX_SAFE_INTEGER + 1), /safe integer/i);
    assert.throws(() => canonicalJson(Number.MIN_SAFE_INTEGER - 1), /safe integer/i);
    assert.throws(() => canonicalJson(1.5), /safe integer/i);
    assert.throws(() => canonicalJson(NaN), /safe integer/i);
    assert.throws(() => canonicalJson(Infinity), /safe integer/i);
  });

  it('rejects non-string input to parseCanonicalJson', () => {
    assert.throws(() => parseCanonicalJson(123 as unknown as string), /must be a string/i);
    assert.throws(() => parseCanonicalJson(null as unknown as string), /must be a string/i);
  });

  it('rejects malformed or non-canonical JSON', () => {
    assert.throws(() => parseCanonicalJson(''), /not valid JSON/i);
    assert.throws(() => parseCanonicalJson('{ "a": 1 }'), /not canonical/i); // has whitespace
    assert.throws(() => parseCanonicalJson('{"b":1,"a":2}'), /not canonical/i); // unsorted keys
    assert.throws(() => parseCanonicalJson('{"a":1.0}'), /not canonical/i); // alternate number spelling
  });

  it('rejects unpaired surrogates (non-well-formed UTF-16)', () => {
    const loneSurrogate = '\uD800';
    assert.throws(() => canonicalJson(loneSurrogate), /surrogate/i);
    assert.throws(() => canonicalJson({ [loneSurrogate]: 'value' }), /surrogate/i);
  });

  it('rejects unsupported types like Date, Function, Symbol, TypedArray', () => {
    assert.throws(() => canonicalJson(new Date() as unknown as null), /unsupported type/i);
    assert.throws(() => canonicalJson((() => {}) as unknown as null), /unsupported type/i);
    assert.throws(() => canonicalJson(Symbol('sym') as unknown as null), /unsupported type/i);
    assert.throws(() => canonicalJson(new Uint8Array(10) as unknown as null), /unsupported type/i);
  });

  it('handles empty and boundary structures correctly', () => {
    assert.equal(canonicalJson({}), '{}');
    assert.equal(canonicalJson([]), '[]');
    assert.equal(canonicalJson(''), '""');
    assert.equal(canonicalJson(null), 'null');
    assert.equal(canonicalJson(false), 'false');
    assert.equal(canonicalJson(0), '0');
  });
});

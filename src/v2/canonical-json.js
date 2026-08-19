'use strict';

/**
 * Serialize and parse the restricted JSON subset used by protocol v2.
 * Parsing rejects syntactically valid JSON that is not byte-for-byte canonical,
 * including duplicate keys, alternate number spellings, whitespace, and an
 * unexpected key order. Callers that receive bytes must validate UTF-8 before
 * passing the decoded string here.
 */
function canonicalJson(value) {
  return serialize(value, '$');
}

function parseCanonicalJson(serialized, label = 'Protocol JSON') {
  if (typeof serialized !== 'string') {
    throw new TypeError(`${label} must be a string`);
  }
  let value;
  try {
    value = JSON.parse(serialized);
  } catch (error) {
    throw new SyntaxError(`${label} is not valid JSON: ${error.message}`);
  }
  if (canonicalJson(value) !== serialized) {
    throw new SyntaxError(`${label} is not canonical JSON`);
  }
  return value;
}

function serialize(value, path) {
  if (value === null) {
    return 'null';
  }

  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'string':
      assertWellFormedString(value, path);
      return JSON.stringify(value);
    case 'number':
      if (!Number.isSafeInteger(value)) {
        throw new TypeError(`Protocol value at ${path} must be a safe integer`);
      }
      return String(value);
    case 'object':
      if (Buffer.isBuffer(value) || value instanceof Date || ArrayBuffer.isView(value)) {
        throw new TypeError(`Protocol value at ${path} has an unsupported type`);
      }
      if (Array.isArray(value)) {
        return `[${value.map((item, index) => serialize(item, `${path}[${index}]`)).join(',')}]`;
      }
      if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
        throw new TypeError(`Protocol value at ${path} must be a plain object`);
      }
      return `{${Object.keys(value).sort().map((key) => {
        assertWellFormedString(key, `${path}.<key>`);
        return `${JSON.stringify(key)}:${serialize(value[key], `${path}.${key}`)}`;
      }).join(',')}}`;
    default:
      throw new TypeError(`Protocol value at ${path} has an unsupported type`);
  }
}

function assertWellFormedString(value, path) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) {
        throw new TypeError(`Protocol string at ${path} contains an unpaired surrogate`);
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new TypeError(`Protocol string at ${path} contains an unpaired surrogate`);
    }
  }
}

module.exports = {
  canonicalJson,
  parseCanonicalJson
};
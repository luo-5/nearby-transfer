'use strict';

/**
 * Serialize the restricted JSON subset used by protocol v2 signatures.
 * Objects are sorted by Unicode code unit, numbers must be safe integers, and
 * unsupported JavaScript values fail closed instead of being silently omitted.
 */
function canonicalJson(value) {
  return serialize(value, '$');
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
  canonicalJson
};

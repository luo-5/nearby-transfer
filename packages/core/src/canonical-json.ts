/**
 * Serialize and parse the restricted JSON subset used by protocol v2.
 * Mirrors src/v2/canonical-json.js.
 *
 * Parsing rejects syntactically valid JSON that is not byte-for-byte canonical,
 * including duplicate keys, alternate number spellings, whitespace, and an
 * unexpected key order. Callers that receive bytes must validate UTF-8 before
 * passing the decoded string here.
 */

export type CanonicalValue = null | boolean | number | string | CanonicalValue[] | { [key: string]: CanonicalValue };

export function canonicalJson(value: CanonicalValue): string {
  return serialize(value, '$');
}

export function parseCanonicalJson(serialized: string, label = 'Protocol JSON'): CanonicalValue {
  if (typeof serialized !== 'string') {
    throw new TypeError(`${label} must be a string`);
  }
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch (error) {
    throw new SyntaxError(`${label} is not valid JSON: ${(error as Error).message}`);
  }
  if (canonicalJson(value as CanonicalValue) !== serialized) {
    throw new SyntaxError(`${label} is not canonical JSON`);
  }
  return value as CanonicalValue;
}

function serialize(value: CanonicalValue, path: string): string {
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
    case 'object': {
      if (isArrayBufferLike(value) || value instanceof Date) {
        throw new TypeError(`Protocol value at ${path} has an unsupported type`);
      }
      if (Array.isArray(value)) {
        return `[${value.map((item, index) => serialize(item, `${path}[${index}]`)).join(',')}]`;
      }
      if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
        throw new TypeError(`Protocol value at ${path} must be a plain object`);
      }
      const record = value as { [key: string]: CanonicalValue };
      return `{${Object.keys(record)
        .sort()
        .map((key) => {
          assertWellFormedString(key, `${path}.<key>`);
          const entry = record[key];
          if (entry === undefined) {
            throw new TypeError(`Protocol value at ${path}.${key} is undefined`);
          }
          return `${JSON.stringify(key)}:${serialize(entry, `${path}.${key}`)}`;
        })
        .join(',')}}`;
    }
    default:
      throw new TypeError(`Protocol value at ${path} has an unsupported type`);
  }
}

function assertWellFormedString(value: string, path: string): void {
  if (!value.isWellFormed()) {
    throw new TypeError(`Protocol string at ${path} contains an unpaired surrogate`);
  }
}

// Duck-type check for Buffer/TypedArray/DataView without importing node types,
// keeping this module free of Node-specific imports.
function isArrayBufferLike(value: object): boolean {
  if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(value)) return true;
  if (typeof Buffer !== 'undefined' && typeof Buffer.isBuffer === 'function' && Buffer.isBuffer(value)) return true;
  return false;
}

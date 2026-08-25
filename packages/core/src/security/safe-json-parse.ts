/**
 * Safe JSON parser with strict limits on depth, key length, string length,
 * and total object keys to prevent memory explosion, stack overflow, and prototype pollution DoS.
 */

export interface SafeJsonParseOptions {
  maxDepth?: number;
  maxKeyLength?: number;
  maxStringLength?: number;
  maxTotalKeys?: number;
  disallowPrototypeKeys?: boolean;
}

const DEFAULT_MAX_DEPTH = 32;
const DEFAULT_MAX_KEY_LENGTH = 256;
const DEFAULT_MAX_STRING_LENGTH = 1024 * 1024; // 1 MB
const DEFAULT_MAX_TOTAL_KEYS = 10000;

export function safeJsonParse(text: string, options: SafeJsonParseOptions = {}): unknown {
  if (typeof text !== 'string') {
    throw new TypeError('safeJsonParse: input must be a string');
  }

  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxKeyLength = options.maxKeyLength ?? DEFAULT_MAX_KEY_LENGTH;
  const maxStringLength = options.maxStringLength ?? DEFAULT_MAX_STRING_LENGTH;
  const maxTotalKeys = options.maxTotalKeys ?? DEFAULT_MAX_TOTAL_KEYS;
  const disallowPrototypeKeys = options.disallowPrototypeKeys ?? true;

  let totalKeys = 0;

  // Reviver function that validates constraints on the fly
  let currentDepth = 0;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text, (key: string, value: unknown) => {
      if (typeof key === 'string' && key.length > 0) {
        if (key.length > maxKeyLength) {
          throw new RangeError(`JSON key exceeds maximum allowed length of ${maxKeyLength} characters`);
        }
        if (disallowPrototypeKeys && (key === '__proto__' || key === 'constructor' || key === 'prototype')) {
          throw new TypeError(`Forbidden prototype key detected: "${key}"`);
        }
        totalKeys++;
        if (totalKeys > maxTotalKeys) {
          throw new RangeError(`JSON object contains more than the maximum allowed total keys (${maxTotalKeys})`);
        }
      }

      if (typeof value === 'string' && value.length > maxStringLength) {
        throw new RangeError(`JSON string value exceeds maximum allowed length of ${maxStringLength} characters`);
      }

      return value;
    });
  } catch (error) {
    if (error instanceof RangeError || error instanceof TypeError) {
      throw error;
    }
    throw new SyntaxError(`Malformed JSON text: ${(error as Error).message}`);
  }

  // Depth verification
  validateDepth(parsed, 1, maxDepth);

  return parsed;
}

function validateDepth(value: unknown, currentDepth: number, maxDepth: number): void {
  if (currentDepth > maxDepth) {
    throw new RangeError(`JSON nesting depth exceeds maximum allowed limit of ${maxDepth}`);
  }

  if (value !== null && typeof value === 'object') {
    if (Array.isArray(value)) {
      for (const item of value) {
        validateDepth(item, currentDepth + 1, maxDepth);
      }
    } else {
      for (const val of Object.values(value)) {
        validateDepth(val, currentDepth + 1, maxDepth);
      }
    }
  }
}

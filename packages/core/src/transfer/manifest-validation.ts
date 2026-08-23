/**
 * Path/task-id validation helpers shared by transfer-session-crypto and the
 * transfer manifest. Ported from src/v2/transfer-manifest.js (validation
 * subset only); the full manifest module is migrated in M1.6.
 */

import { Buffer } from 'node:buffer';

export const TASK_ID_BYTES = 16;
export const TASK_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;
export const MAX_RELATIVE_PATH_BYTES = 4_096;
export const MAX_PATH_COMPONENT_BYTES = 255;
const WINDOWS_INVALID_COMPONENT_PATTERN = /[<>:"\\/|?*\u0000-\u001f\u007f]/;

export function assertValidTaskId(taskId: string): void {
  if (typeof taskId !== 'string' || !TASK_ID_PATTERN.test(taskId)) {
    throw new TypeError('Transfer task ID must be a 16-byte base64url value');
  }
  let decoded: Buffer;
  try {
    decoded = Buffer.from(taskId, 'base64url');
  } catch {
    throw new TypeError('Transfer task ID must be a valid base64url value');
  }
  if (decoded.length !== TASK_ID_BYTES || decoded.toString('base64url') !== taskId) {
    throw new TypeError('Transfer task ID must be a canonical 16-byte base64url value');
  }
}

export function assertValidRelativePath(relativePath: string): void {
  if (typeof relativePath !== 'string' || relativePath.length === 0) {
    throw new TypeError('Transfer path must be a non-empty string');
  }
  assertWellFormedString(relativePath, 'Transfer path');

  if (Buffer.byteLength(relativePath, 'utf8') > MAX_RELATIVE_PATH_BYTES) {
    throw new RangeError('Transfer path exceeds the maximum UTF-8 length');
  }
  if (relativePath.startsWith('/') || relativePath.startsWith('\\') || /^[A-Za-z]:/.test(relativePath) || relativePath.includes('\\')) {
    throw new TypeError('Transfer path must use a relative POSIX path');
  }

  const components = relativePath.split('/');
  for (const component of components) {
    if (component.length === 0 || component === '.' || component === '..') {
      throw new TypeError('Transfer path must not contain empty or traversal components');
    }
    if (Buffer.byteLength(component, 'utf8') > MAX_PATH_COMPONENT_BYTES) {
      throw new RangeError('Transfer path component exceeds the maximum UTF-8 length');
    }
    if (WINDOWS_INVALID_COMPONENT_PATTERN.test(component)) {
      throw new TypeError('Transfer path component contains a Windows-invalid character');
    }
  }
}

export function assertWellFormedString(value: string, subject: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) {
        throw new TypeError(`${subject} contains an unpaired surrogate`);
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new TypeError(`${subject} contains an unpaired surrogate`);
    }
  }
}

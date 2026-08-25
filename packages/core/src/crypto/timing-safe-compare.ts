/**
 * Constant-time comparison utilities to prevent timing side-channel attacks.
 *
 * Use these instead of === when comparing secrets (signatures, tokens, MACs,
 * fingerprints, device IDs). Regular string comparison short-circuits on the
 * first mismatched byte, leaking how many leading bytes match.
 */

import crypto from 'node:crypto';
import { Buffer } from 'node:buffer';

export function timingSafeEqualBuffers(a: Uint8Array, b: Uint8Array): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

export function timingSafeEqualStrings(a: string, b: string): boolean {
  const hashA = crypto.createHash('sha256').update(a, 'utf8').digest();
  const hashB = crypto.createHash('sha256').update(b, 'utf8').digest();
  const match = crypto.timingSafeEqual(hashA, hashB);
  return match && a.length === b.length;
}

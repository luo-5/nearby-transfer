/**
 * Device identity cryptography: Ed25519 signing keypairs, X25519 ECDH keypairs,
 * device-id derivation, and key fingerprints. Ported from src/core/crypto.js
 * (identity subset) and src/core/config.js (deviceId derivation).
 *
 * Pure functions over node:crypto — no fs, no Electron.
 */

import crypto from 'node:crypto';
import { Buffer } from 'node:buffer';

export type KeyAlgorithm = 'ed25519' | 'x25519';

export interface KeyPair {
  publicKey: string; // PEM (SPKI)
  privateKey: string; // PEM (PKCS#8)
}

/** Generate an Ed25519 signing keypair, returned as canonical PEM strings. */
export function createEd25519KeyPair(): KeyPair {
  return crypto.generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
}

/** Generate an X25519 keypair used in session key agreement. */
export function createX25519KeyPair(): KeyPair {
  return crypto.generateKeyPairSync('x25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
}

/**
 * Generate a keypair of the given curve. Kept for API compatibility with the
 * original src/core/crypto.js signature.
 */
export function createKeyPair(type: KeyAlgorithm): KeyPair {
  return type === 'ed25519' ? createEd25519KeyPair() : createX25519KeyPair();
}

/**
 * Derive the 16-hex-char device id from an Ed25519 signing public key (PEM).
 * This is the first 16 characters of the SHA-256 of the PEM string.
 */
export function deriveDeviceId(signingPublicKeyPem: string): string {
  return crypto.createHash('sha256').update(signingPublicKeyPem).digest('hex').slice(0, 16);
}

/**
 * Compute the human-readable fingerprint of a public key (PEM): the first six
 * 4-hex-char groups of the SHA-256, joined by hyphens (e.g. "A1B2-C3D4-...").
 */
export function fingerprintFor(publicKeyPem: string): string {
  const hex = crypto.createHash('sha256').update(publicKeyPem).digest('hex').toUpperCase();
  return hex.match(/.{1,4}/g)!.slice(0, 6).join('-');
}

/** Sign an arbitrary message with an Ed25519 private key (PEM). Returns raw bytes. */
export function sign(message: Uint8Array, privateKeyPem: string): Buffer {
  return crypto.sign(null, Buffer.from(message), crypto.createPrivateKey(privateKeyPem));
}

/** Verify an Ed25519 signature. Returns false on any failure rather than throwing. */
export function verify(message: Uint8Array, signature: Uint8Array, publicKeyPem: string): boolean {
  try {
    return crypto.verify(null, Buffer.from(message), crypto.createPublicKey(publicKeyPem), Buffer.from(signature));
  } catch {
    return false;
  }
}

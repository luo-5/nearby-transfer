/**
 * Public-identity shape used in discovery announcements and pairing messages.
 * Extracted from src/v2/pairing.js so that discovery and pairing can both
 * import it without creating a circular dependency.
 */

import crypto from 'node:crypto';
import { APP_ID, MAX_CAPABILITIES, MAX_CAPABILITY_LENGTH, MAX_DEVICE_NAME_LENGTH, MAX_PUBLIC_KEY_LENGTH, PROTOCOL_VERSION } from '../constants.js';
import { canonicalJson } from '../canonical-json.js';
import { assertWellFormedString } from '../transfer/manifest-validation.js';
import { deriveDeviceId, fingerprintFor } from '../crypto/identity.js';

const DEVICE_ID_PATTERN = /^[a-f0-9]{16}$/;
const CAPABILITY_PATTERN = /^[a-z][a-z0-9-]*$/;

export interface PublicIdentity {
  deviceId: string;
  deviceName: string;
  fingerprint: string;
  signingPublicKey: string;
  encryptionPublicKey: string;
}

/** Extract the public-identity fields from a full device object. */
export function publicIdentity(device: {
  deviceId?: string;
  deviceName?: string;
  fingerprint?: string;
  signingPublicKey?: string;
  encryptionPublicKey?: string;
}): PublicIdentity {
  return {
    deviceId: device?.deviceId ?? '',
    deviceName: device?.deviceName ?? '',
    fingerprint: device?.fingerprint ?? '',
    signingPublicKey: device?.signingPublicKey ?? '',
    encryptionPublicKey: device?.encryptionPublicKey ?? '',
  };
}

/** Validate a public identity: key types, deviceId/fingerprint consistency. */
export function assertValidPublicIdentity(identity: unknown): asserts identity is PublicIdentity {
  if (!identity || typeof identity !== 'object' || Array.isArray(identity)) {
    throw new TypeError('Identity must be an object');
  }

  const normalized = publicIdentity(identity as Record<string, string>);
  if (!DEVICE_ID_PATTERN.test(normalized.deviceId)) {
    throw new TypeError('Identity device ID must be 16 lowercase hexadecimal characters');
  }
  if (!isBoundedText(normalized.deviceName, MAX_DEVICE_NAME_LENGTH)) {
    throw new TypeError('Identity device name is invalid');
  }
  if (!isBoundedText(normalized.signingPublicKey, MAX_PUBLIC_KEY_LENGTH) || !isBoundedText(normalized.encryptionPublicKey, MAX_PUBLIC_KEY_LENGTH)) {
    throw new TypeError('Identity public key is invalid');
  }
  if (!/^[0-9A-F]{4}(?:-[0-9A-F]{4}){5}$/.test(normalized.fingerprint)) {
    throw new TypeError('Identity fingerprint is invalid');
  }

  let signingKey: crypto.KeyObject;
  let encryptionKey: crypto.KeyObject;
  try {
    signingKey = crypto.createPublicKey(normalized.signingPublicKey);
    encryptionKey = crypto.createPublicKey(normalized.encryptionPublicKey);
  } catch {
    throw new TypeError('Identity contains an unreadable public key');
  }
  if (signingKey.asymmetricKeyType !== 'ed25519' || encryptionKey.asymmetricKeyType !== 'x25519') {
    throw new TypeError('Identity contains unexpected public key types');
  }

  const expectedDeviceId = deriveDeviceId(normalized.signingPublicKey);
  if (normalized.deviceId !== expectedDeviceId || normalized.fingerprint !== fingerprintFor(normalized.signingPublicKey)) {
    throw new TypeError('Identity metadata does not match signing public key');
  }
}

export function normalizeCapabilities(capabilities: unknown): string[] {
  if (!Array.isArray(capabilities) || capabilities.length > MAX_CAPABILITIES) throw new TypeError('Discovery capabilities must be a bounded array');
  const normalized = capabilities.map((capability: unknown) => {
    if (typeof capability !== 'string' || capability.length === 0 || capability.length > MAX_CAPABILITY_LENGTH || !CAPABILITY_PATTERN.test(capability)) {
      throw new TypeError('Discovery capability is invalid');
    }
    return capability;
  });
  if (new Set(normalized).size !== normalized.length) throw new TypeError('Discovery capabilities must not contain duplicates');
  return normalized.slice().sort();
}

function isBoundedText(value: unknown, maxLength: number): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength || value.includes('\0')) return false;
  assertWellFormedString(value, 'Identity text');
  return true;
}

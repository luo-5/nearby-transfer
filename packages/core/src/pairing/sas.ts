/**
 * SAS 6-digit pairing code derivation, pairing offer/confirmation/cancel
 * creation and Ed25519 signing/verification.
 *
 * Ported from src/v2/pairing.js. The pairing code is derived from a SHA-256
 * over a canonical-JSON transcript binding the pairingId to both parties'
 * public identities, so both sides compute the same 6-digit code independently
 * and can detect a man-in-the-middle by comparing codes out-of-band.
 */

import crypto from 'node:crypto';
import { Buffer } from 'node:buffer';
import { APP_ID, PROTOCOL_VERSION, PAIRING_CODE_DIGITS, PAIRING_ID_BYTES, MAX_PUBLIC_KEY_LENGTH, MESSAGE_TYPES } from '../constants.js';
import { canonicalJson, type CanonicalValue } from '../canonical-json.js';
import { assertWellFormedString } from '../transfer/manifest-validation.js';
import { publicIdentity, assertValidPublicIdentity, normalizeCapabilities, type PublicIdentity } from './identity-shape.js';

export const DEVICE_ID_PATTERN = /^[a-f0-9]{16}$/;
export const PAIRING_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;
export const PAIRING_CODE_PATTERN = /^[0-9]{6}$/;
export const PAIRING_CODE_DOMAIN = 'nearby-transfer/v2/pairing-code\0';
export const PAIRING_CANCEL_REASONS = new Set(['connection-closed', 'rejected', 'timeout', 'user-cancelled']);

export interface PairingCodeContext {
  pairingId: string;
  initiator: PublicIdentity;
  responder: PublicIdentity;
}

export interface PairingOffer {
  app: string;
  protocolVersion: number;
  type: string;
  pairingId: string;
  issuedAt: number;
  identity: PublicIdentity;
  capabilities: string[];
  signature?: string;
}

export interface PairingConfirmation {
  app: string;
  protocolVersion: number;
  type: string;
  pairingId: string;
  issuedAt: number;
  deviceId: string;
  pairingCode: string;
  signature?: string;
}

export interface PairingCancel {
  app: string;
  protocolVersion: number;
  type: string;
  pairingId: string;
  issuedAt: number;
  deviceId: string;
  reason: string;
  signature?: string;
}

export interface PairingDevice extends PublicIdentity {
  signingPrivateKey: string;
}

/** Generate a random 16-byte pairing ID as base64url (22 chars). */
export function createPairingId(): string {
  return crypto.randomBytes(PAIRING_ID_BYTES).toString('base64url');
}

/** Canonical-JSON transcript of the pairing code context (initiator + responder + pairingId). */
export function pairingCodeTranscript(context: PairingCodeContext): string {
  if (!PAIRING_ID_PATTERN.test(context.pairingId || '')) {
    throw new TypeError('Pairing ID must be a 16-byte base64url value');
  }
  assertValidPublicIdentity(context.initiator);
  assertValidPublicIdentity(context.responder);
  return canonicalJson({
    app: APP_ID,
    protocolVersion: PROTOCOL_VERSION,
    type: 'pairing-code',
    pairingId: context.pairingId,
    initiator: publicIdentity(context.initiator),
    responder: publicIdentity(context.responder),
  } as unknown as CanonicalValue);
}

/** Derive the 6-digit SAS pairing code from the transcript. */
export function derivePairingCode(context: PairingCodeContext): string {
  const hash = crypto.createHash('sha256').update(PAIRING_CODE_DOMAIN, 'utf8').update(pairingCodeTranscript(context), 'utf8').digest();
  const code = hash.readUInt32BE(0) % 10 ** PAIRING_CODE_DIGITS;
  return String(code).padStart(PAIRING_CODE_DIGITS, '0');
}

export function createPairingOffer({
  device,
  capabilities = [],
  pairingId = createPairingId(),
  issuedAt = Date.now(),
}: {
  device: PairingDevice;
  capabilities?: string[];
  pairingId?: string;
  issuedAt?: number;
}): PairingOffer {
  const offer: PairingOffer = {
    app: APP_ID,
    protocolVersion: PROTOCOL_VERSION,
    type: MESSAGE_TYPES.PAIRING_OFFER,
    pairingId,
    issuedAt,
    identity: publicIdentity(device),
    capabilities: normalizeCapabilities(capabilities),
  };
  assertValidPairingOffer(offer);
  return offer;
}

export function createPairingConfirmation({
  pairingId,
  device,
  pairingCode,
  issuedAt = Date.now(),
}: {
  pairingId: string;
  device: PairingDevice;
  pairingCode: string;
  issuedAt?: number;
}): PairingConfirmation {
  const confirmation: PairingConfirmation = {
    app: APP_ID,
    protocolVersion: PROTOCOL_VERSION,
    type: MESSAGE_TYPES.PAIRING_CONFIRM,
    pairingId,
    issuedAt,
    deviceId: publicIdentity(device).deviceId,
    pairingCode,
  };
  assertValidPairingConfirmation(confirmation);
  return confirmation;
}

export function createPairingCancel({
  pairingId,
  device,
  reason = 'user-cancelled',
  issuedAt = Date.now(),
}: {
  pairingId: string;
  device: PairingDevice;
  reason?: string;
  issuedAt?: number;
}): PairingCancel {
  const cancellation: PairingCancel = {
    app: APP_ID,
    protocolVersion: PROTOCOL_VERSION,
    type: MESSAGE_TYPES.PAIRING_CANCEL,
    pairingId,
    issuedAt,
    deviceId: publicIdentity(device).deviceId,
    reason,
  };
  assertValidPairingCancel(cancellation);
  return cancellation;
}

export function signPairingOffer(offer: PairingOffer, privateKeyPem: string): string {
  assertValidPairingOffer(offer);
  return crypto.sign(null, Buffer.from(pairingOfferSigningPayload(offer), 'utf8'), crypto.createPrivateKey(privateKeyPem)).toString('base64');
}

export function verifyPairingOffer(offer: PairingOffer, signature: string | undefined): boolean {
  try {
    assertValidPairingOffer(offer);
    return verifySignedPayload(pairingOfferSigningPayload(offer), signature, offer.identity.signingPublicKey);
  } catch {
    return false;
  }
}

export function signPairingConfirmation(confirmation: PairingConfirmation, privateKeyPem: string): string {
  assertValidPairingConfirmation(confirmation);
  return crypto.sign(null, Buffer.from(pairingConfirmationSigningPayload(confirmation), 'utf8'), crypto.createPrivateKey(privateKeyPem)).toString('base64');
}

export function verifyPairingConfirmation(confirmation: PairingConfirmation, signature: string | undefined, signingPublicKey: string): boolean {
  try {
    assertValidPairingConfirmation(confirmation);
    return verifySignedPayload(pairingConfirmationSigningPayload(confirmation), signature, signingPublicKey);
  } catch {
    return false;
  }
}

export function signPairingCancel(cancellation: PairingCancel, privateKeyPem: string): string {
  assertValidPairingCancel(cancellation);
  return crypto.sign(null, Buffer.from(pairingCancelSigningPayload(cancellation), 'utf8'), crypto.createPrivateKey(privateKeyPem)).toString('base64');
}

export function verifyPairingCancel(cancellation: PairingCancel, signature: string | undefined, signingPublicKey: string): boolean {
  try {
    assertValidPairingCancel(cancellation);
    return verifySignedPayload(pairingCancelSigningPayload(cancellation), signature, signingPublicKey);
  } catch {
    return false;
  }
}

export function assertValidPairingOffer(offer: unknown): asserts offer is PairingOffer {
  if (!offer || typeof offer !== 'object' || Array.isArray(offer)) throw new TypeError('Pairing offer must be an object');
  const o = offer as Record<string, unknown>;
  if (o.app !== APP_ID || o.protocolVersion !== PROTOCOL_VERSION || o.type !== MESSAGE_TYPES.PAIRING_OFFER) throw new TypeError('Pairing offer has an unsupported protocol envelope');
  if (!PAIRING_ID_PATTERN.test((o.pairingId as string) || '')) throw new TypeError('Pairing ID must be a 16-byte base64url value');
  if (!Number.isSafeInteger(o.issuedAt) || (o.issuedAt as number) <= 0) throw new TypeError('Pairing offer issue time must be a positive safe integer');
  assertValidPublicIdentity(o.identity);
  normalizeCapabilities(o.capabilities);
}

export function assertValidPairingConfirmation(confirmation: unknown): asserts confirmation is PairingConfirmation {
  if (!confirmation || typeof confirmation !== 'object' || Array.isArray(confirmation)) throw new TypeError('Pairing confirmation must be an object');
  const c = confirmation as Record<string, unknown>;
  if (c.app !== APP_ID || c.protocolVersion !== PROTOCOL_VERSION || c.type !== MESSAGE_TYPES.PAIRING_CONFIRM) throw new TypeError('Pairing confirmation has an unsupported protocol envelope');
  if (!PAIRING_ID_PATTERN.test((c.pairingId as string) || '')) throw new TypeError('Pairing ID must be a 16-byte base64url value');
  if (!Number.isSafeInteger(c.issuedAt) || (c.issuedAt as number) <= 0) throw new TypeError('Pairing confirmation issue time must be a positive safe integer');
  if (!DEVICE_ID_PATTERN.test((c.deviceId as string) || '')) throw new TypeError('Pairing confirmation device ID is invalid');
  if (typeof c.pairingCode !== 'string' || c.pairingCode.length !== PAIRING_CODE_DIGITS || !PAIRING_CODE_PATTERN.test(c.pairingCode)) throw new TypeError('Pairing confirmation code is invalid');
}

export function assertValidPairingCancel(cancellation: unknown): asserts cancellation is PairingCancel {
  if (!cancellation || typeof cancellation !== 'object' || Array.isArray(cancellation)) throw new TypeError('Pairing cancellation must be an object');
  const c = cancellation as Record<string, unknown>;
  if (c.app !== APP_ID || c.protocolVersion !== PROTOCOL_VERSION || c.type !== MESSAGE_TYPES.PAIRING_CANCEL) throw new TypeError('Pairing cancellation has an unsupported protocol envelope');
  if (!PAIRING_ID_PATTERN.test((c.pairingId as string) || '')) throw new TypeError('Pairing ID must be a 16-byte base64url value');
  if (!Number.isSafeInteger(c.issuedAt) || (c.issuedAt as number) <= 0) throw new TypeError('Pairing cancellation issue time must be a positive safe integer');
  if (!DEVICE_ID_PATTERN.test((c.deviceId as string) || '')) throw new TypeError('Pairing cancellation device ID is invalid');
  if (typeof c.reason !== 'string' || !PAIRING_CANCEL_REASONS.has(c.reason)) throw new TypeError('Pairing cancellation reason is invalid');
}

function pairingOfferSigningPayload(offer: PairingOffer): string {
  assertValidPairingOffer(offer);
  return canonicalJson({
    app: offer.app,
    protocolVersion: offer.protocolVersion,
    type: offer.type,
    pairingId: offer.pairingId,
    issuedAt: offer.issuedAt,
    identity: publicIdentity(offer.identity),
    capabilities: normalizeCapabilities(offer.capabilities),
  } as unknown as CanonicalValue);
}

function pairingConfirmationSigningPayload(confirmation: PairingConfirmation): string {
  assertValidPairingConfirmation(confirmation);
  return canonicalJson({
    app: confirmation.app,
    protocolVersion: confirmation.protocolVersion,
    type: confirmation.type,
    pairingId: confirmation.pairingId,
    issuedAt: confirmation.issuedAt,
    deviceId: confirmation.deviceId,
    pairingCode: confirmation.pairingCode,
  } as unknown as CanonicalValue);
}

function pairingCancelSigningPayload(cancellation: PairingCancel): string {
  assertValidPairingCancel(cancellation);
  return canonicalJson({
    app: cancellation.app,
    protocolVersion: cancellation.protocolVersion,
    type: cancellation.type,
    pairingId: cancellation.pairingId,
    issuedAt: cancellation.issuedAt,
    deviceId: cancellation.deviceId,
    reason: cancellation.reason,
  } as unknown as CanonicalValue);
}

function verifySignedPayload(payload: string, signature: string | undefined, signingPublicKey: string): boolean {
  if (typeof signature !== 'string' || signature.length === 0 || signature.length > 512 || typeof signingPublicKey !== 'string' || signingPublicKey.length === 0 || signingPublicKey.length > MAX_PUBLIC_KEY_LENGTH) {
    return false;
  }
  const key = crypto.createPublicKey(signingPublicKey);
  if (key.asymmetricKeyType !== 'ed25519') return false;
  return crypto.verify(null, Buffer.from(payload, 'utf8'), key, Buffer.from(signature, 'base64'));
}

// Re-export identity-shape helpers for convenience (pairing is the canonical home).
export { publicIdentity, assertValidPublicIdentity, normalizeCapabilities, type PublicIdentity };
// Suppress unused import
void assertWellFormedString;

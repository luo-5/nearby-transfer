'use strict';

/**
 * Strangler fig adapter — re-exports pairing functions from @luo-5/core.
 *
 * The old flat module exported 20 members. The TS core library split these
 * across identity-shape.ts and sas.ts, but all 17 "real" pairing functions
 * are re-exported from the package barrel. The 3 *SigningPayload helpers
 * were made private in the core library; we re-implement them here using
 * exported core functions so test/ consumers (protocol-v2-fixtures-smoke)
 * keep working.
 *
 * Compatibility note: the old assertValidPublicIdentity returned the
 * normalized identity object. The new core version is a void assertion
 * function. We wrap it to return the normalized identity so existing
 * consumers (trusted-peer-store, pairing-session-store) keep working.
 */

const core = require('@luo-5/core');

function assertValidPublicIdentity(identity) {
  core.assertValidPublicIdentity(identity);
  return core.publicIdentity(identity);
}

function pairingOfferSigningPayload(offer) {
  core.assertValidPairingOffer(offer);
  return core.canonicalJson({
    app: offer.app,
    protocolVersion: offer.protocolVersion,
    type: offer.type,
    pairingId: offer.pairingId,
    issuedAt: offer.issuedAt,
    identity: core.publicIdentity(offer.identity),
    capabilities: core.normalizeCapabilities(offer.capabilities),
  });
}

function pairingConfirmationSigningPayload(confirmation) {
  core.assertValidPairingConfirmation(confirmation);
  return core.canonicalJson({
    app: confirmation.app,
    protocolVersion: confirmation.protocolVersion,
    type: confirmation.type,
    pairingId: confirmation.pairingId,
    issuedAt: confirmation.issuedAt,
    deviceId: confirmation.deviceId,
    pairingCode: confirmation.pairingCode,
  });
}

function pairingCancelSigningPayload(cancellation) {
  core.assertValidPairingCancel(cancellation);
  return core.canonicalJson({
    app: cancellation.app,
    protocolVersion: cancellation.protocolVersion,
    type: cancellation.type,
    pairingId: cancellation.pairingId,
    issuedAt: cancellation.issuedAt,
    deviceId: cancellation.deviceId,
    reason: cancellation.reason,
  });
}

module.exports = {
  assertValidPublicIdentity,
  assertValidPairingOffer: core.assertValidPairingOffer,
  assertValidPairingConfirmation: core.assertValidPairingConfirmation,
  assertValidPairingCancel: core.assertValidPairingCancel,
  createPairingId: core.createPairingId,
  createPairingOffer: core.createPairingOffer,
  createPairingConfirmation: core.createPairingConfirmation,
  createPairingCancel: core.createPairingCancel,
  derivePairingCode: core.derivePairingCode,
  pairingCodeTranscript: core.pairingCodeTranscript,
  pairingOfferSigningPayload,
  pairingConfirmationSigningPayload,
  pairingCancelSigningPayload,
  publicIdentity: core.publicIdentity,
  signPairingOffer: core.signPairingOffer,
  signPairingConfirmation: core.signPairingConfirmation,
  signPairingCancel: core.signPairingCancel,
  verifyPairingOffer: core.verifyPairingOffer,
  verifyPairingConfirmation: core.verifyPairingConfirmation,
  verifyPairingCancel: core.verifyPairingCancel,
};

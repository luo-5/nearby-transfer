'use strict';

/**
 * Strangler fig adapter — re-exports pairing functions from @luo-5/core.
 *
 * The old flat module exported 20 members. The TS core library split these
 * across identity-shape.ts and sas.ts, but all 17 "real" pairing functions
 * are re-exported from the package barrel. The 3 *SigningPayload helpers
 * were made private in the core library and are dropped here — no consumer
 * under src/ uses them.
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
  publicIdentity: core.publicIdentity,
  signPairingOffer: core.signPairingOffer,
  signPairingConfirmation: core.signPairingConfirmation,
  signPairingCancel: core.signPairingCancel,
  verifyPairingOffer: core.verifyPairingOffer,
  verifyPairingConfirmation: core.verifyPairingConfirmation,
  verifyPairingCancel: core.verifyPairingCancel,
};

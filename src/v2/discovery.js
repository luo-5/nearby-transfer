'use strict';

/**
 * Strangler fig adapter — re-exports discovery module from @luo-5/core.
 * The original implementation has been replaced by the TypeScript core library.
 */

const {
  V2Discovery,
  DISCOVERY_PORT,
  createDiscoveryAnnouncement,
  discoveryAnnouncementSigningPayload,
  signDiscoveryAnnouncement,
  verifyDiscoveryAnnouncement,
  parseDiscoveryDatagram,
  assertValidDiscoveryAnnouncement,
  assertFreshDiscoveryAnnouncement,
} = require('../vendor/luo5-core/index.cjs');

module.exports = {
  V2Discovery,
  DISCOVERY_PORT,
  createDiscoveryAnnouncement,
  discoveryAnnouncementSigningPayload,
  signDiscoveryAnnouncement,
  verifyDiscoveryAnnouncement,
  parseDiscoveryDatagram,
  assertValidDiscoveryAnnouncement,
  assertFreshDiscoveryAnnouncement,
};

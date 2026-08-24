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
} = require('@luo-5/core');

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

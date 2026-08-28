'use strict';

const core = require('@luo-5/core');

module.exports = {
  RESERVATION_ROOT_NAME: core.RESERVATION_ROOT_NAME,
  STAGING_PREFIX: core.STAGING_PREFIX,
  STAGING_SUFFIX: core.STAGING_SUFFIX,
  cleanupReceiveStaging: core.cleanupReceiveStaging,
  planReceiveTargets: core.planReceiveTargets,
};

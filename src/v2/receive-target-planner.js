'use strict';

const core = require('../vendor/luo5-core/index.cjs');

module.exports = {
  RESERVATION_ROOT_NAME: core.RESERVATION_ROOT_NAME,
  STAGING_PREFIX: core.STAGING_PREFIX,
  STAGING_SUFFIX: core.STAGING_SUFFIX,
  cleanupReceiveStaging: core.cleanupReceiveStaging,
  planReceiveTargets: core.planReceiveTargets,
};

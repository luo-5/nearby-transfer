'use strict';

/**
 * Strangler fig adapter — re-exports canonical JSON functions from @luo-5/core.
 * The original implementation has been replaced by the TypeScript core library.
 */

const { canonicalJson, parseCanonicalJson } = require('@luo-5/core');

module.exports = { canonicalJson, parseCanonicalJson };

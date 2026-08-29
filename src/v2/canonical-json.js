'use strict';

/**
 * Strangler fig adapter — re-exports canonical JSON functions from @luo-5/core.
 * The original implementation has been replaced by the TypeScript core library.
 */

const { canonicalJson, parseCanonicalJson } = require('../vendor/luo5-core/index.cjs');

module.exports = { canonicalJson, parseCanonicalJson };

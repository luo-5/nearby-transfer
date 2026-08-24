'use strict';

/**
 * Strangler fig adapter — re-exports protocol constants from @luo-5/core.
 * The original implementation has been replaced by the TypeScript core library.
 */

const {
  APP_ID,
  PROTOCOL_VERSION,
  PAIRING_CODE_DIGITS,
  PAIRING_ID_BYTES,
  MAX_DEVICE_NAME_LENGTH,
  MAX_PUBLIC_KEY_LENGTH,
  MAX_CAPABILITIES,
  MAX_CAPABILITY_LENGTH,
  MESSAGE_TYPES,
} = require('@luo-5/core');

module.exports = {
  APP_ID,
  PROTOCOL_VERSION,
  PAIRING_CODE_DIGITS,
  PAIRING_ID_BYTES,
  MAX_DEVICE_NAME_LENGTH,
  MAX_PUBLIC_KEY_LENGTH,
  MAX_CAPABILITIES,
  MAX_CAPABILITY_LENGTH,
  MESSAGE_TYPES,
};

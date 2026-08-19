'use strict';

const APP_ID = 'nearby-transfer';
const PROTOCOL_VERSION = 2;
const PAIRING_CODE_DIGITS = 6;
const PAIRING_ID_BYTES = 16;
const MAX_DEVICE_NAME_LENGTH = 128;
const MAX_PUBLIC_KEY_LENGTH = 4096;
const MAX_CAPABILITIES = 16;
const MAX_CAPABILITY_LENGTH = 64;

const MESSAGE_TYPES = Object.freeze({
  DISCOVERY_ANNOUNCE: 'discovery-announce',
  PAIRING_OFFER: 'pairing-offer',
  PAIRING_CONFIRM: 'pairing-confirm',
  PAIRING_CANCEL: 'pairing-cancel',
  TRANSFER_MANIFEST: 'transfer-manifest',
  TRANSFER_CHUNK: 'transfer-chunk',
  TRANSFER_COMPLETE: 'transfer-complete',
  LIBRARY_SESSION: 'library-session'
});

module.exports = {
  APP_ID,
  PROTOCOL_VERSION,
  PAIRING_CODE_DIGITS,
  PAIRING_ID_BYTES,
  MAX_DEVICE_NAME_LENGTH,
  MAX_PUBLIC_KEY_LENGTH,
  MAX_CAPABILITIES,
  MAX_CAPABILITY_LENGTH,
  MESSAGE_TYPES
};

/**
 * Protocol v2 constants. Mirrors src/v2/constants.js.
 */

export const APP_ID = 'nearby-transfer';
export const PROTOCOL_VERSION = 2;
export const PAIRING_CODE_DIGITS = 6;
export const PAIRING_ID_BYTES = 16;
export const MAX_DEVICE_NAME_LENGTH = 128;
export const MAX_PUBLIC_KEY_LENGTH = 4096;
export const MAX_CAPABILITIES = 16;
export const MAX_CAPABILITY_LENGTH = 64;

export const MESSAGE_TYPES = Object.freeze({
  DISCOVERY_ANNOUNCE: 'discovery-announce',
  PAIRING_OFFER: 'pairing-offer',
  PAIRING_CONFIRM: 'pairing-confirm',
  PAIRING_CANCEL: 'pairing-cancel',
  TRANSFER_MANIFEST: 'transfer-manifest',
  TRANSFER_DECISION: 'transfer-decision',
  TRANSFER_RESUME: 'transfer-resume',
  TRANSFER_PROGRESS: 'transfer-progress',
  TRANSFER_CHUNK: 'transfer-chunk',
  TRANSFER_COMPLETE: 'transfer-complete',
  TRANSFER_STREAM_CONTROL: 'transfer-stream-control',
  LIBRARY_SESSION: 'library-session',
} as const);

export type MessageType = (typeof MESSAGE_TYPES)[keyof typeof MESSAGE_TYPES];

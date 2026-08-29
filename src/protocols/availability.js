'use strict';

const { PROTOCOLS } = require('./protocol-types');

const DEFAULT_TRANSFER_PROTOCOL = PROTOCOLS.V1_CLASSIC;

const availabilityById = Object.freeze({
  [PROTOCOLS.V2_STREAM]: Object.freeze({
    id: PROTOCOLS.V2_STREAM,
    available: false,
    experimental: true,
    reason: 'The v2 transfer executor is not connected to the desktop send and receive flow yet.'
  }),
  [PROTOCOLS.TURBO_PARALLEL]: Object.freeze({
    id: PROTOCOLS.TURBO_PARALLEL,
    available: false,
    experimental: true,
    reason: 'The Turbo driver is currently a protocol adapter scaffold.'
  }),
  [PROTOCOLS.QUIC_UDP]: Object.freeze({
    id: PROTOCOLS.QUIC_UDP,
    available: false,
    experimental: true,
    reason: 'The QUIC driver is currently a protocol adapter scaffold.'
  }),
  [PROTOCOLS.SMB_SHARE]: Object.freeze({
    id: PROTOCOLS.SMB_SHARE,
    available: false,
    experimental: true,
    reason: 'The SMB driver is currently a protocol adapter scaffold.'
  }),
  [PROTOCOLS.WEBDAV_SYNC]: Object.freeze({
    id: PROTOCOLS.WEBDAV_SYNC,
    available: false,
    experimental: true,
    reason: 'The WebDAV protocol driver is not connected to the desktop transfer selector.'
  }),
  [PROTOCOLS.V1_CLASSIC]: Object.freeze({
    id: PROTOCOLS.V1_CLASSIC,
    available: true,
    experimental: false,
    reason: null
  }),
  [PROTOCOLS.FTPS_SECURE]: Object.freeze({
    id: PROTOCOLS.FTPS_SECURE,
    available: false,
    experimental: true,
    reason: 'The FTPS driver is currently a protocol adapter scaffold.'
  })
});

function listProtocolAvailability() {
  return Object.values(availabilityById).map((entry) => ({ ...entry }));
}

function getProtocolAvailability(protocolId) {
  const entry = availabilityById[protocolId];
  return entry ? { ...entry } : null;
}

function normalizeTransferProtocol(protocolId) {
  const entry = availabilityById[protocolId];
  return entry && entry.available ? entry.id : DEFAULT_TRANSFER_PROTOCOL;
}

function validateTransferProtocol(protocolId) {
  const entry = availabilityById[protocolId];
  if (!entry) {
    return { ok: false, code: 'PROTOCOL_UNKNOWN', error: 'Unknown transfer protocol.' };
  }
  if (!entry.available) {
    return { ok: false, code: 'PROTOCOL_EXPERIMENTAL', error: entry.reason };
  }
  return { ok: true, protocol: entry.id };
}

module.exports = {
  DEFAULT_TRANSFER_PROTOCOL,
  getProtocolAvailability,
  listProtocolAvailability,
  normalizeTransferProtocol,
  validateTransferProtocol
};

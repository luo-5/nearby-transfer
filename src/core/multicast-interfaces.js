'use strict';

const os = require('os');

const LINK_LOCAL_PREFIX = '169.254.';
const OVERRIDE_ENV = 'NEARBY_TRANSFER_MULTICAST_INTERFACES';

function multicastInterfaces(networkInterfaces = os.networkInterfaces(), override = process.env[OVERRIDE_ENV]) {
  const available = new Set();
  for (const entries of Object.values(networkInterfaces || {})) {
    for (const entry of entries || []) {
      if (!entry || entry.internal || !isIpv4(entry) || entry.address.startsWith(LINK_LOCAL_PREFIX)) continue;
      available.add(entry.address);
    }
  }

  const requested = parseOverride(override);
  if (requested.length > 0) return requested.filter((address) => available.has(address));
  return Array.from(available).sort();
}

function parseOverride(value) {
  if (typeof value !== 'string') return [];
  return Array.from(new Set(value.split(',').map((address) => address.trim()).filter(isIpv4Address))).sort();
}

function isIpv4(entry) {
  return entry.family === 'IPv4' || entry.family === 4;
}

function isIpv4Address(address) {
  if (typeof address !== 'string') return false;
  const octets = address.split('.');
  return octets.length === 4 && octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255);
}

module.exports = {
  OVERRIDE_ENV,
  multicastInterfaces,
  parseOverride
};

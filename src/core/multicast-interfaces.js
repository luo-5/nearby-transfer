'use strict';

const os = require('os');

const LINK_LOCAL_PREFIX = '169.254.';
const OVERRIDE_ENV = 'NEARBY_TRANSFER_MULTICAST_INTERFACES';
const VIRTUAL_OR_TUNNEL_INTERFACE = /(vmware|virtualbox|vbox|hyper-v|vethernet|docker|wsl|wintun|wireguard|tailscale|zerotier|hamachi|tap(?:[ -]|\d|$)|tun(?:[ -]|\d|$)|vpn|virtual|tunnel)/i;

function multicastInterfaces(networkInterfaces = os.networkInterfaces(), override = process.env[OVERRIDE_ENV]) {
  const available = new Set();
  const preferred = new Set();

  for (const [name, entries] of Object.entries(networkInterfaces || {})) {
    const ignoredByDefault = isVirtualOrTunnelInterface(name);
    for (const entry of entries || []) {
      if (!isUsableIpv4(entry)) continue;
      available.add(entry.address);
      if (!ignoredByDefault) preferred.add(entry.address);
    }
  }

  const requested = parseOverride(override);
  if (requested.length > 0) return requested.filter((address) => available.has(address));
  return Array.from(preferred).sort();
}

function parseOverride(value) {
  if (typeof value !== 'string') return [];
  return Array.from(new Set(value.split(',').map((address) => address.trim()).filter(isIpv4Address))).sort();
}

function isUsableIpv4(entry) {
  return entry && !entry.internal && isIpv4(entry) && isIpv4Address(entry.address) && !entry.address.startsWith(LINK_LOCAL_PREFIX);
}

function isIpv4(entry) {
  return entry.family === 'IPv4' || entry.family === 4;
}

function isIpv4Address(address) {
  if (typeof address !== 'string') return false;
  const octets = address.split('.');
  return octets.length === 4 && octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255);
}

function isVirtualOrTunnelInterface(name) {
  return typeof name === 'string' && VIRTUAL_OR_TUNNEL_INTERFACE.test(name);
}

module.exports = {
  OVERRIDE_ENV,
  multicastInterfaces,
  parseOverride
};

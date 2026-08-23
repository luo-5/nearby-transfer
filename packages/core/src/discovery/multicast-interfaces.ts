/**
 * Enumerate usable IPv4 multicast interfaces on the host.
 * Ported from src/core/multicast-interfaces.js.
 */

import os from 'node:os';

export const OVERRIDE_ENV = 'NEARBY_TRANSFER_MULTICAST_INTERFACES';
const LINK_LOCAL_PREFIX = '169.254.';
const VIRTUAL_OR_TUNNEL_INTERFACE =
  /(vmware|virtualbox|vbox|hyper-v|vethernet|docker|wsl|wintun|wireguard|tailscale|zerotier|hamachi|tap(?:[ -]|\d|$)|tun(?:[ -]|\d|$)|vpn|virtual|tunnel)/i;

export interface NetworkInterfaceEntry {
  address: string;
  family: string | number;
  internal: boolean;
}

export function multicastInterfaces(
  networkInterfaces: Record<string, NetworkInterfaceEntry[] | undefined> = os.networkInterfaces() as unknown as Record<string, NetworkInterfaceEntry[] | undefined>,
  override: string | undefined = process.env[OVERRIDE_ENV],
): string[] {
  const available = new Set<string>();
  const preferred = new Set<string>();

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

export function parseOverride(value: string | undefined): string[] {
  if (typeof value !== 'string') return [];
  return Array.from(new Set(value.split(',').map((address) => address.trim()).filter(isIpv4Address))).sort();
}

function isUsableIpv4(entry: NetworkInterfaceEntry): boolean {
  return !!entry && !entry.internal && isIpv4(entry) && isIpv4Address(entry.address) && !entry.address.startsWith(LINK_LOCAL_PREFIX);
}

function isIpv4(entry: NetworkInterfaceEntry): boolean {
  return entry.family === 'IPv4' || entry.family === 4;
}

export function isIpv4Address(address: string): boolean {
  if (typeof address !== 'string') return false;
  const octets = address.split('.');
  return octets.length === 4 && octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255);
}

function isVirtualOrTunnelInterface(name: string): boolean {
  return typeof name === 'string' && VIRTUAL_OR_TUNNEL_INTERFACE.test(name);
}

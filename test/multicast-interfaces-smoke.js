const assert = require('assert');
const { OVERRIDE_ENV, multicastInterfaces, parseOverride } = require('../src/core/multicast-interfaces');

function adapter(address) {
  return { address, family: 'IPv4', internal: false };
}

function main() {
  const networkInterfaces = {
    loopback: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
    wifi: [
      { address: 'fe80::1', family: 'IPv6', internal: false },
      adapter('192.168.1.20'),
      adapter('192.168.1.20')
    ],
    ethernet: [{ address: '10.0.0.8', family: 4, internal: false }],
    linkLocal: [adapter('169.254.8.7')],
    'VMware Network Adapter VMnet8': [adapter('192.168.128.1')],
    'VirtualBox Host-Only Network': [adapter('192.168.56.1')],
    'vEthernet (Default Switch)': [adapter('172.20.64.1')],
    'DockerNAT': [adapter('10.10.0.1')],
    'WSL (Hyper-V firewall)': [adapter('172.29.0.1')],
    Wintun: [adapter('10.7.0.2')],
    WireGuard: [adapter('10.8.0.2')],
    Tailscale: [adapter('100.64.0.2')],
    ZeroTier: [adapter('10.147.17.2')],
    Hamachi: [adapter('25.0.0.2')],
    'TAP-Windows Adapter V9': [adapter('10.9.0.2')],
    'TUN adapter': [adapter('10.11.0.2')],
    'Corporate VPN': [adapter('10.12.0.2')],
    Tunnel: [adapter('10.13.0.2')]
  };

  assert.deepStrictEqual(multicastInterfaces(networkInterfaces), ['10.0.0.8', '192.168.1.20']);
  assert.deepStrictEqual(parseOverride(' 192.168.1.20,10.0.0.8,192.168.1.20,invalid '), ['10.0.0.8', '192.168.1.20']);
  assert.deepStrictEqual(
    multicastInterfaces(networkInterfaces, '192.168.128.1,192.168.1.20,10.7.0.2,203.0.113.3'),
    ['10.7.0.2', '192.168.1.20', '192.168.128.1']
  );
  assert.deepStrictEqual(multicastInterfaces(networkInterfaces, 'invalid'), ['10.0.0.8', '192.168.1.20']);
  assert.deepStrictEqual(multicastInterfaces({ Wintun: [adapter('10.7.0.2')] }), []);
  assert.strictEqual(OVERRIDE_ENV, 'NEARBY_TRANSFER_MULTICAST_INTERFACES');
}

main();

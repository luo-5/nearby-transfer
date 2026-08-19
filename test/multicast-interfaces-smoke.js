const assert = require('assert');
const { OVERRIDE_ENV, multicastInterfaces, parseOverride } = require('../src/core/multicast-interfaces');

function main() {
  const networkInterfaces = {
    loopback: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
    wifi: [
      { address: 'fe80::1', family: 'IPv6', internal: false },
      { address: '192.168.1.20', family: 'IPv4', internal: false }
    ],
    ethernet: [{ address: '10.0.0.8', family: 4, internal: false }],
    linkLocal: [{ address: '169.254.8.7', family: 'IPv4', internal: false }]
  };

  assert.deepStrictEqual(multicastInterfaces(networkInterfaces), ['10.0.0.8', '192.168.1.20']);
  assert.deepStrictEqual(parseOverride(' 192.168.1.20,10.0.0.8,192.168.1.20,invalid '), ['10.0.0.8', '192.168.1.20']);
  assert.deepStrictEqual(multicastInterfaces(networkInterfaces, '192.168.1.20,203.0.113.3'), ['192.168.1.20']);
  assert.deepStrictEqual(multicastInterfaces(networkInterfaces, 'invalid'), ['10.0.0.8', '192.168.1.20']);
  assert.strictEqual(OVERRIDE_ENV, 'NEARBY_TRANSFER_MULTICAST_INTERFACES');
}

main();

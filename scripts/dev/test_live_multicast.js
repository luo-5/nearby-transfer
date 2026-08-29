'use strict';
const os = require('os');
const { multicastInterfaces } = require('../src/core/multicast-interfaces');

console.log('All network interfaces:', os.networkInterfaces());
console.log('Detected Multicast Interfaces:', multicastInterfaces());

'use strict';

const major = Number.parseInt(process.versions.node.split('.')[0], 10);

if (!Number.isSafeInteger(major) || major < 24) {
  console.error(`Nearby Transfer requires Node.js 24 or newer; found ${process.version}.`);
  process.exit(1);
}

try {
  require('node:sqlite');
} catch (error) {
  console.error(`This Node.js runtime does not provide node:sqlite: ${error.message}`);
  process.exit(1);
}

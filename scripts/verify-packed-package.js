'use strict';

const fs = require('fs');
const path = require('path');

const [manifestPath, contentsPath] = process.argv.slice(2);
if (!manifestPath || !contentsPath) {
  throw new Error('Usage: node scripts/verify-packed-package.js <package.json> <tar-contents.txt>');
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const contents = new Set(
  fs.readFileSync(contentsPath, 'utf8').split(/\r?\n/).filter(Boolean),
);
const targets = new Set();

for (const field of ['main', 'module', 'types']) addTarget(manifest[field]);
addTarget(manifest.bin);
addTarget(manifest.exports);

if (targets.size === 0) throw new Error('Packed package does not declare a public entry point');
for (const target of targets) {
  const normalized = target.replace(/^\.\//, '').replace(/\\/g, '/');
  if (!normalized || path.posix.isAbsolute(normalized) || normalized.split('/').includes('..')) {
    throw new Error(`Packed package entry is not a safe relative path: ${target}`);
  }
  if (!contents.has(`package/${normalized}`)) {
    throw new Error(`Packed package is missing declared entry: ${target}`);
  }
}

function addTarget(value) {
  if (typeof value === 'string') {
    targets.add(value);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const nested of Object.values(value)) addTarget(nested);
}

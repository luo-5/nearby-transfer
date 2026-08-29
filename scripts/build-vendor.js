#!/usr/bin/env node
'use strict';

/**
 * Build @luo-5/core and copy its dist output into src/vendor/luo5-core.
 *
 * The desktop app requires the core library from this vendored path so the
 * packaged Electron bundle ships the code without electron-builder having to
 * resolve the workspace devDependency. Hooked via prestart/predist/pretest.
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const rootDir = path.join(__dirname, '..');
const coreDistDir = path.join(rootDir, 'packages', 'core', 'dist');
const vendorDir = path.join(rootDir, 'src', 'vendor', 'luo5-core');

function main() {
  execSync('npm run build --workspace @luo-5/core', { cwd: rootDir, stdio: 'inherit' });

  const indexCjs = path.join(coreDistDir, 'index.cjs');
  if (!fs.existsSync(indexCjs)) {
    throw new Error(`Core build did not produce ${indexCjs}`);
  }

  fs.rmSync(vendorDir, { recursive: true, force: true });
  fs.mkdirSync(vendorDir, { recursive: true });
  for (const entry of fs.readdirSync(coreDistDir)) {
    fs.cpSync(path.join(coreDistDir, entry), path.join(vendorDir, entry), { recursive: true });
  }

  const requiredEntries = ['index.cjs', 'index.js', 'index.d.ts'];
  for (const name of requiredEntries) {
    if (!fs.existsSync(path.join(vendorDir, name))) {
      throw new Error(`Vendored core is missing ${name}`);
    }
  }
  console.log(`Vendored @luo-5/core -> ${path.relative(rootDir, vendorDir)}`);
}

try {
  main();
} catch (error) {
  console.error('build-vendor failed:', error.message);
  process.exit(1);
}

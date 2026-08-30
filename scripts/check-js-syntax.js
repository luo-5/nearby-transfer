'use strict';

const { readdirSync } = require('node:fs');
const { join, relative } = require('node:path');
const { execFileSync } = require('node:child_process');

const repositoryRoot = join(__dirname, '..');
const sourceRoots = ['src', 'test'];
const ignoredDirectories = new Set(['node_modules', 'vendor']);
const checkedExtensions = new Set(['.js', '.cjs', '.mjs']);

function collectJavaScriptFiles(directory) {
  const files = [];

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) {
        files.push(...collectJavaScriptFiles(join(directory, entry.name)));
      }
      continue;
    }

    const extension = entry.name.slice(entry.name.lastIndexOf('.'));
    if (entry.isFile() && checkedExtensions.has(extension)) {
      files.push(join(directory, entry.name));
    }
  }

  return files;
}

const files = sourceRoots
  .flatMap((sourceRoot) => collectJavaScriptFiles(join(repositoryRoot, sourceRoot)))
  .sort((left, right) => left.localeCompare(right));

if (files.length === 0) {
  console.error('No JavaScript files were found under src/ or test/.');
  process.exit(1);
}

for (const file of files) {
  execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' });
}

console.log(`Syntax checked ${files.length} JavaScript files.`);

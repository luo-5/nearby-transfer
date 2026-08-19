const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ensureSafeDirectory, safeFilename, uniqueDestinationPath } = require('../src/core/path-utils');

function main() {
  assert.strictEqual(safeFilename('../../secret.txt'), 'secret.txt');
  assert.strictEqual(safeFilename('report<>:"|?*.txt'), 'report_______.txt');
  assert.strictEqual(safeFilename('report.txt...   '), 'report.txt');
  assert.strictEqual(safeFilename('...'), 'file');

  for (const reservedName of [
    'CON',
    'con.txt',
    'PRN.log',
    'AUX',
    'NUL.json',
    'NUL.tar.gz',
    'COM1.bin',
    'com9',
    'COM¹.txt',
    'LPT1.txt',
    'lpt9.csv',
    'LPT³.data',
    'CON .txt'
  ]) {
    assert.strictEqual(safeFilename(reservedName).startsWith('_'), true, reservedName);
  }

  assert.strictEqual(safeFilename('COM10.txt'), 'COM10.txt');
  assert.strictEqual(safeFilename('LPT0.txt'), 'LPT0.txt');
  assert.strictEqual(safeFilename('console.txt'), 'console.txt');

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nearby-transfer-path-'));
  try {
    assert.strictEqual(ensureSafeDirectory(directory), path.resolve(directory));
    fs.writeFileSync(path.join(directory, 'photo.jpg'), 'existing');
    fs.writeFileSync(path.join(directory, 'photo (1).jpg'), 'existing');

    assert.strictEqual(
      uniqueDestinationPath(directory, 'photo.jpg'),
      path.join(directory, 'photo (2).jpg')
    );
    assert.strictEqual(
      uniqueDestinationPath(directory, 'CON.txt'),
      path.join(directory, '_CON.txt')
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }

  assert.throws(() => ensureSafeDirectory('relative/path'), /absolute/i);

  const tempParent = fs.mkdtempSync(path.join(os.tmpdir(), 'nearby-transfer-path-file-'));
  try {
    const file = path.join(tempParent, 'not-a-directory');
    fs.writeFileSync(file, 'content');
    assert.throws(() => ensureSafeDirectory(file), /directory/i);
  } finally {
    fs.rmSync(tempParent, { recursive: true, force: true });
  }
}

main();
const fs = require('fs');
const path = require('path');

const WINDOWS_RESERVED_BASENAME = /^(?:CON|PRN|AUX|NUL|COM(?:[1-9]|[¹²³])|LPT(?:[1-9]|[¹²³]))$/i;

function safeFilename(fileName) {
  const baseName = path.basename(String(fileName || 'file'));
  const safe = baseName
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .trim()
    .replace(/[. ]+$/g, '');

  if (!safe) {
    return 'file';
  }

  const windowsBasename = safe.split('.', 1)[0].replace(/[. ]+$/g, '');
  return WINDOWS_RESERVED_BASENAME.test(windowsBasename) ? `_${safe}` : safe;
}

function ensureSafeDirectory(directory) {
  if (typeof directory !== 'string' || !directory.trim()) {
    throw new Error('Invalid directory');
  }

  if (!path.isAbsolute(directory)) {
    throw new Error('Directory must be absolute');
  }

  const absolute = path.resolve(directory);
  let entry;
  try {
    entry = fs.lstatSync(absolute);
  } catch (error) {
    if (error && error.code !== 'ENOENT') {
      throw error;
    }
    fs.mkdirSync(absolute, { recursive: true });
    entry = fs.lstatSync(absolute);
  }

  if (!entry.isDirectory()) {
    throw new Error('Directory path must point to a directory');
  }
  if (entry.isSymbolicLink()) {
    throw new Error('Directory path must not be a symbolic link');
  }

  const real = fs.realpathSync.native(absolute);
  if (!samePath(real, absolute)) {
    throw new Error('Directory path must resolve to itself');
  }

  return absolute;
}

function uniqueDestinationPath(directory, fileName) {
  const parsed = path.parse(safeFilename(fileName));
  let candidate = path.join(directory, parsed.base);
  let index = 1;

  while (fs.existsSync(candidate)) {
    const suffix = ` (${index})`;
    candidate = path.join(directory, `${parsed.name}${suffix}${parsed.ext}`);
    index += 1;
  }

  return candidate;
}

function samePath(left, right) {
  if (process.platform === 'win32') {
    return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
  }
  return path.resolve(left) === path.resolve(right);
}

function walkDirectory(dirPath, filesList = [], visited = new Set()) {
  let realDir = dirPath;
  try {
    realDir = fs.realpathSync(dirPath);
  } catch (_) {}
  if (visited.has(realDir)) return filesList;
  visited.add(realDir);

  try {
    const files = fs.readdirSync(dirPath);
    for (const file of files) {
      const fullPath = path.join(dirPath, file);
      let stat;
      try {
        stat = fs.lstatSync(fullPath);
      } catch (_) {
        continue;
      }
      if (stat.isSymbolicLink()) {
        continue;
      }
      if (stat.isDirectory()) {
        walkDirectory(fullPath, filesList, visited);
      } else if (stat.isFile()) {
        filesList.push({ path: fullPath, size: stat.size, name: path.basename(fullPath) });
      }
    }
  } catch (_) {}
  return filesList;
}

module.exports = {
  safeFilename,
  ensureSafeDirectory,
  uniqueDestinationPath,
  samePath,
  walkDirectory
};
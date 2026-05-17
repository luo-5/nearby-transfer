const fs = require('fs');
const path = require('path');

function safeFilename(fileName) {
  const baseName = path.basename(String(fileName || 'file'));
  const safe = baseName.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').trim();
  return safe || 'file';
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

module.exports = {
  safeFilename,
  uniqueDestinationPath
};

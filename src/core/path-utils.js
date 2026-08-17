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

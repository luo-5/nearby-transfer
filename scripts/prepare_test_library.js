const fs = require('fs');
const path = require('path');
const os = require('os');

const base = path.join(os.homedir(), 'AppData', 'Roaming', 'nearby-transfer', 'SharedLibrary');
if (!fs.existsSync(base)) fs.mkdirSync(base, { recursive: true });

function ensureDir(p) {
  const full = path.join(base, p);
  if (!fs.existsSync(full)) fs.mkdirSync(full, { recursive: true });
}

function ensureFile(p, content) {
  const full = path.join(base, p);
  fs.writeFileSync(full, content, 'utf8');
}

ensureDir('我的相册/2026旅行');
ensureDir('我的相册/壁纸合集');
ensureDir('工作文档');

ensureFile('我的相册/2026旅行/富士山日出.jpg', 'FAKE_JPG_BINARY_CONTENT');
ensureFile('我的相册/2026旅行/京都樱花.png', 'FAKE_PNG_BINARY_CONTENT');
ensureFile('我的相册/2026旅行/旅行日志.txt', '2026年去日本旅行，富士山和京都非常美！');
ensureFile('我的相册/壁纸合集/4K星空.jpg', 'FAKE_JPG_WALLPAPER');
ensureFile('工作文档/2026技术方案.pdf', 'FAKE_PDF_DOCUMENT');
ensureFile('工作文档/项目代码.js', 'console.log("Nearby Transfer NAS WebDAV v1.1.0 Ready!");');
ensureFile('工作文档/数据归档.zip', 'FAKE_ZIP_ARCHIVE');
ensureFile('欢迎使用附近传输-共享库.txt', '欢迎使用全新升级的 NAS 多级共享文件库！');

console.log('[+] Test directories and files created successfully at:\n' + base);

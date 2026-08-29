'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');

const referencesDir = path.join(__dirname, '..', 'references');
if (!fs.existsSync(referencesDir)) {
  fs.mkdirSync(referencesDir, { recursive: true });
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    console.log(`Fetching from: ${url}`);
    const file = fs.createWriteStream(dest);
    
    function get(currentUrl) {
      https.get(currentUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
      }, (response) => {
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          get(response.headers.location);
          return;
        }
        if (response.statusCode !== 200) {
          reject(new Error(`Failed with HTTP ${response.statusCode}`));
          return;
        }
        let total = parseInt(response.headers['content-length'] || '0', 10);
        let cur = 0;
        response.on('data', (chunk) => {
          cur += chunk.length;
          if (total > 0) {
            process.stdout.write(`\rDownloading: ${(cur / 1024 / 1024).toFixed(2)} MB / ${(total / 1024 / 1024).toFixed(2)} MB`);
          }
        });
        response.pipe(file);
        file.on('finish', () => {
          file.close();
          console.log('\nDownload complete.');
          resolve();
        });
      }).on('error', (err) => {
        fs.unlink(dest, () => {});
        reject(err);
      });
    }

    get(url);
  });
}

async function main() {
  const localsendZip = path.join(referencesDir, 'localsend.zip');
  console.log('=== 1. DOWNLOADING LOCALSEND (60k+ stars) ===');
  await downloadFile('https://github.com/localsend/localsend/archive/refs/heads/main.zip', localsendZip);
  
  console.log('Unpacking localsend...');
  execSync(`powershell -Command "Expand-Archive -Path '${localsendZip}' -DestinationPath '${referencesDir}' -Force; Remove-Item '${localsendZip}' -Force"`);
  console.log('[+] LocalSend extracted successfully!');

  const alistZip = path.join(referencesDir, 'alist.zip');
  console.log('\n=== 2. DOWNLOADING ALIST (45k+ stars) ===');
  await downloadFile('https://github.com/alist-org/alist/archive/refs/heads/main.zip', alistZip);

  console.log('Unpacking alist...');
  execSync(`powershell -Command "Expand-Archive -Path '${alistZip}' -DestinationPath '${referencesDir}' -Force; Remove-Item '${alistZip}' -Force"`);
  console.log('[+] AList extracted successfully!');
}

main().catch(console.error);

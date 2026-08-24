'use strict';

// Bootstrap helper for the curl-based WebDAV interop script. Starts a
// DesktopLibraryService with a pre-seeded trusted peer, mints a Bearer token,
// prints PORT=<port> and TOKEN=<token> to stdout (one per line), and keeps the
// server running until killed. The curl script reads these values and issues
// standard WebDAV requests.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { DesktopLibraryService } = require('../src/v2/desktop-library-service');

class MockTrustedPeerStore {
  constructor(peers = {}) { this.peers = new Map(Object.entries(peers)); }
  getPeer(deviceId) { return this.peers.get(deviceId) || null; }
}

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-webdav-curl-'));
  const shareDir = path.join(tempDir, 'share');
  fs.mkdirSync(shareDir);
  fs.writeFileSync(path.join(shareDir, 'hello.txt'), 'Hello WebDAV World');
  fs.mkdirSync(path.join(shareDir, 'subfolder'));
  fs.writeFileSync(path.join(shareDir, 'subfolder', 'nested.txt'), 'Nested Content');

  const peerStore = new MockTrustedPeerStore({
    'interop-peer': {
      deviceId: 'interop-peer',
      isTrusted: () => true,
      permissions: { libraryRead: true, libraryUpload: true, transfer: true }
    }
  });

  const service = new DesktopLibraryService({
    trustedPeerStore: peerStore,
    shares: [{ id: 'docs', name: 'Documents', localPath: shareDir, readOnly: false }]
  });

  const port = await service.start(0);
  const token = service.createSessionToken('interop-peer');

  // Signal readiness to the parent shell script
  process.stdout.write(`PORT=${port}\n`);
  process.stdout.write(`TOKEN=${token}\n`);
  process.stdout.write(`SHARE=docs\n`);
  process.stdout.write(`TEMPDIR=${tempDir}\n`);

  process.on('SIGTERM', async () => {
    await service.stop();
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
    process.exit(0);
  });
  process.on('SIGINT', async () => {
    await service.stop();
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
    process.exit(0);
  });
}

main().catch((err) => { console.error('FATAL:', err); process.exit(1); });

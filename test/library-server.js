'use strict';

// Standalone shared library server for testing. Creates a DesktopLibraryService
// with a pre-seeded trusted peer (the test client), so the client can authenticate
// and exercise the full WebDAV API without the full Electron app.
//
// Usage:
//   node test/library-server.js --port 56578 --share-dir /tmp/nt-library \
//     --client-identity-file /tmp/nt-sender-identity.json

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { DesktopLibraryService } = require('../src/v2/desktop-library-service');
const { TrustedPeerStore } = require('../src/v2/trusted-peer-store');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const val = argv[i + 1];
      if (val && !val.startsWith('--')) { args[key] = val; i++; }
      else args[key] = true;
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const port = parseInt(args.port || '56578', 10);
  const shareDir = args['share-dir'] || path.join(os.tmpdir(), 'nt-library');
  const clientIdentityFile = args['client-identity-file'];

  if (!clientIdentityFile) {
    console.error('Usage: node test/library-server.js --port <port> --share-dir <dir> --client-identity-file <path>');
    process.exit(1);
  }

  fs.mkdirSync(shareDir, { recursive: true });

  // Load client identity to pre-seed as trusted peer
  const raw = fs.readFileSync(clientIdentityFile, 'utf8');
  const clientIdentity = JSON.parse(raw.trim().split('\n')[0]);

  // Create a temp user data dir for the SQLite store
  const userDataDir = path.join(os.tmpdir(), 'nt-library-test-' + process.pid);
  fs.mkdirSync(userDataDir, { recursive: true });

  // Create trusted peer store and pre-seed the client
  const trustedPeerStore = new TrustedPeerStore(userDataDir);
  trustedPeerStore.upsertTrustedPeer({
    identity: {
      deviceId: clientIdentity.deviceId,
      deviceName: clientIdentity.deviceName || 'Test Client',
      fingerprint: clientIdentity.fingerprint || '',
      signingPublicKey: clientIdentity.signingPublicKey,
      encryptionPublicKey: clientIdentity.encryptionPublicKey
    },
    displayName: clientIdentity.deviceName || 'Test Client',
    permissions: { transfer: true, libraryRead: true, libraryUpload: true },
    pairedAt: Date.now(),
    lastSeen: Date.now()
  });

  console.log(JSON.stringify({
    type: 'INFO',
    msg: `library server starting: port=${port}, shareDir=${shareDir}, client=${clientIdentity.deviceId}`
  }));

  // Catch any unhandled errors so they show in the log
  process.on('uncaughtException', (err) => {
    console.log(JSON.stringify({ type: 'UNCAUGHT', error: err.message, stack: err.stack }));
  });
  process.on('unhandledRejection', (err) => {
    console.log(JSON.stringify({ type: 'UNHANDLED_REJECTION', error: String(err) }));
  });

  // Create and start the library service
  const service = new DesktopLibraryService({
    trustedPeerStore,
    shares: [{
      id: 'default-share',
      name: 'Test Shared Library',
      localPath: shareDir,
      readOnly: false
    }]
  });

  const actualPort = await service.start(port);
  console.log(JSON.stringify({
    type: 'LIBRARY_READY',
    port: actualPort,
    shareDir,
    shareId: 'default-share',
    clientDeviceId: clientIdentity.deviceId
  }));

  // Keep alive
  console.log(JSON.stringify({ type: 'INFO', msg: `listening on 0.0.0.0:${actualPort}` }));

  // Handle shutdown
  process.on('SIGINT', async () => {
    console.log(JSON.stringify({ type: 'INFO', msg: 'shutting down' }));
    await service.stop();
    trustedPeerStore.close();
    process.exit(0);
  });

  // Auto-exit after 120s of inactivity (safety)
  setTimeout(() => {
    console.log(JSON.stringify({ type: 'INFO', msg: 'auto-exit after timeout' }));
    service.stop().then(() => { trustedPeerStore.close(); process.exit(0); });
  }, 120000);
}

main().catch((error) => {
  console.log(JSON.stringify({ type: 'FATAL', error: error.message, stack: error.stack }));
  process.exit(1);
});

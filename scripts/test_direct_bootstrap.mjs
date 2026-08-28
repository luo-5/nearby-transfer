import net from 'node:net';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
const core = await import(pathToFileURL(path.join(REPO_ROOT, 'packages', 'core', 'dist', 'index.js')).href);

const {
  buildTransferSourceManifest,
  bootstrapOutgoingTransfer
} = core;

// Devices
const UBUNTU_DEV = {
  deviceId: "99add766887178ba",
  deviceName: "node-ubuntu",
  signingPublicKey: "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAvDZnRhwakc0b8EGYxQynWINo/WcHfh7Mbbo/n7TI0zA=\n-----END PUBLIC KEY-----\n",
  signingPrivateKey: "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIFnRrIOp6XVwCIszEvyk4EI0M5ikr/p1b9X8HzunPcXO\n-----END PRIVATE KEY-----\n",
  encryptionPublicKey: "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VuAyEAcGdyjRREYSUYez65YeNfg93z1uinfIadrxqwm7kphSM=\n-----END PUBLIC KEY-----\n",
  encryptionPrivateKey: "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VuBCIEIIiAiqrUeYuqdryG77HjF+4Z7/sWiOXjroMFFZMPBSlF\n-----END PRIVATE KEY-----\n"
};

const PHONE1_DEV = {
  deviceId: "e23c38b8389afb57",
  deviceName: "22041211AC",
  signingPublicKey: "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAl7q3TLbch3XFodrIRmUlecja3dLWwhMMHgBRDLTZtjM=\n-----END PUBLIC KEY-----\n",
  signingPrivateKey: "-----BEGIN PRIVATE KEY-----\nMFECAQEwBQYDK2VwBCIEIFGvxYpSY2StD2d9P5y80q+b2hL39M9VERY8b74CSx/4\ngSEAl7q3TLbch3XFodrIRmUlecja3dLWwhMMHgBRDLTZtjM=\n-----END PRIVATE KEY-----\n",
  encryptionPublicKey: "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VuAyEABiy8WVaEC649l4vFjs512DcAtXA4v2evXqM3x3ipLRM=\n-----END PUBLIC KEY-----\n",
  encryptionPrivateKey: "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VuBCIEIJ/WvuRI3cQcw/cMucpywg9Cech6xJwe/PoZBjCSxBOa\n-----END PRIVATE KEY-----\n"
};

async function testBootstrap() {
  console.log('[*] Connecting to Phone 1 on forwarded port 49881...');
  const stream = net.connect(49881, '127.0.0.1');

  stream.on('connect', async () => {
    console.log('[+] Socket connected! Building manifest...');
    const sm = await buildTransferSourceManifest([fileURLToPath(import.meta.url)], {});
    const sessionId = crypto.randomBytes(16).toString('base64url');
    
    const { publicKey } = crypto.generateKeyPairSync('x25519');
    const spki = publicKey.export({ type: 'spki', format: 'der' });
    const rawPublicKey = spki.subarray(12);
    const ephemeralPublicKey = rawPublicKey.toString('base64url');

    try {
      console.log('[*] Starting bootstrapOutgoingTransfer...');
      const res = await bootstrapOutgoingTransfer({
        stream,
        localDevice: UBUNTU_DEV,
        remotePeer: PHONE1_DEV,
        manifest: sm.manifest,
        senderEphemeralPublicKey: ephemeralPublicKey,
        sessionId,
        timeoutMs: 30000
      });
      console.log('[+] Bootstrap result:', res);
    } catch (e) {
      console.error('[!] Bootstrap error:', e);
    }
  });

  stream.on('error', (err) => console.error('[!] Stream error:', err));
  stream.on('close', () => console.log('[*] Stream closed'));
}

testBootstrap();

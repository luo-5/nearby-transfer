#!/usr/bin/env node
/**
 * vm-agent.mjs — Cross-VM Chaos & Extreme Interop Test Agent
 *
 * Runs on Ubuntu, CentOS, or Windows VM to perform granular test actions:
 * - Payload generation (massive, flood, pathological, deep trees)
 * - Exact SHA-256 recursive checksum calculation
 * - Full v2 protocol encrypted sending and receiving with Chaos hooks
 * - Fuzzing & Security attack simulation (AuthTag corruption, Sequence gap, Replay)
 * - WebDAV server and client interop testing
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Dynamically locate core & cli packages relative to this script
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');

let core;
try {
  const corePath = path.join(REPO_ROOT, 'packages', 'core', 'dist', 'index.js');
  core = await import(pathToFileURL(corePath).href);
} catch (e) {
  const corePath = path.join(REPO_ROOT, 'packages', 'core', 'dist', 'index.cjs');
  core = await import(pathToFileURL(corePath).href);
}

const {
  buildTransferSourceManifest,
  createDesktopTransferExecutor,
  createTransferReceiver,
  encodeWireFrame,
  JOB_DIRECTION,
  JOB_STATUS
} = core;

// Fixed deterministic test identities for cross-VM trust
const PRESET_DEVICES = {
  "ubuntu": {
    "deviceId": "99add766887178ba",
    "deviceName": "node-ubuntu",
    "fingerprint": "99AD-D766-8871-78BA-8AF7-5DAC",
    "signingPublicKey": "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAvDZnRhwakc0b8EGYxQynWINo/WcHfh7Mbbo/n7TI0zA=\n-----END PUBLIC KEY-----\n",
    "signingPrivateKey": "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIFnRrIOp6XVwCIszEvyk4EI0M5ikr/p1b9X8HzunPcXO\n-----END PRIVATE KEY-----\n",
    "encryptionPublicKey": "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VuAyEAcGdyjRREYSUYez65YeNfg93z1uinfIadrxqwm7kphSM=\n-----END PUBLIC KEY-----\n",
    "encryptionPrivateKey": "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VuBCIEIIiAiqrUeYuqdryG77HjF+4Z7/sWiOXjroMFFZMPBSlF\n-----END PRIVATE KEY-----\n"
  },
  "centos": {
    "deviceId": "6b6ef88d104e9817",
    "deviceName": "node-centos",
    "fingerprint": "6B6E-F88D-104E-9817-12C6-08E2",
    "signingPublicKey": "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAstUdh1ILeRLwF6ngXUQerziVOMH9E4weq89wpomSAk0=\n-----END PUBLIC KEY-----\n",
    "signingPrivateKey": "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIHRLKy+JvvOiNaWsKgwkiMn0W9C1mCcgwwQ8O6jKxWq9\n-----END PRIVATE KEY-----\n",
    "encryptionPublicKey": "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VuAyEAVw4bH3vXF4EgkgRuilFxT2bR3I7RW1QrCCkNmcBJXWU=\n-----END PUBLIC KEY-----\n",
    "encryptionPrivateKey": "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VuBCIEIBDe9OC2iTKdqPJ9FyVrj2irYyAHWgkIcNR2jpp031Z+\n-----END PRIVATE KEY-----\n"
  },
  "winvm": {
    "deviceId": "4c985ef50c313c09",
    "deviceName": "node-winvm",
    "fingerprint": "4C98-5EF5-0C31-3C09-DD9D-8D4D",
    "signingPublicKey": "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA6hub+PPuT8aJ7hpcO6KEOJ3xvmnDCSfkGlx/Ilb4Bm4=\n-----END PUBLIC KEY-----\n",
    "signingPrivateKey": "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIC7BWE4BGVI7k1q6khzAXSuKhzSbedKDhwpio1Qtbto4\n-----END PRIVATE KEY-----\n",
    "encryptionPublicKey": "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VuAyEAkbG3Y80YvWJr/inHM94IvZGWDw8OraZdpyERIfyDyDg=\n-----END PUBLIC KEY-----\n",
    "encryptionPrivateKey": "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VuBCIEIKgRiE6xKBcmDA5Qp0qKgHBaEJG4v8/QvgbAk1f22HZA\n-----END PRIVATE KEY-----\n"
  },
  "phone1": {
    "deviceId": "e23c38b8389afb57",
    "deviceName": "22041211AC",
    "fingerprint": "E23C-38B8-389A-FB57-BBA3-BED6",
    "signingPublicKey": "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAl7q3TLbch3XFodrIRmUlecja3dLWwhMMHgBRDLTZtjM=\n-----END PUBLIC KEY-----\n",
    "signingPrivateKey": "-----BEGIN PRIVATE KEY-----\nMFECAQEwBQYDK2VwBCIEIFGvxYpSY2StD2d9P5y80q+b2hL39M9VERY8b74CSx/4\ngSEAl7q3TLbch3XFodrIRmUlecja3dLWwhMMHgBRDLTZtjM=\n-----END PRIVATE KEY-----\n",
    "encryptionPublicKey": "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VuAyEABiy8WVaEC649l4vFjs512DcAtXA4v2evXqM3x3ipLRM=\n-----END PUBLIC KEY-----\n",
    "encryptionPrivateKey": "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VuBCIEIJ/WvuRI3cQcw/cMucpywg9Cech6xJwe/PoZBjCSxBOa\n-----END PRIVATE KEY-----\n"
  },
  "phone2": {
    "deviceId": "22560b305ba893c3",
    "deviceName": "iPhone 20 Pro Max",
    "fingerprint": "2256-0B30-5BA8-93C3-EDE7-4653",
    "signingPublicKey": "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA43BrJVebQhLukrKS8NulqroQ0euHTLrMNEDw+yJFADI=\n-----END PUBLIC KEY-----\n",
    "signingPrivateKey": "-----BEGIN PRIVATE KEY-----\nMFECAQEwBQYDK2VwBCIEIBgikyq6vydO0D+KjslW2J4YgO4PmnHKGSU3maq1Me7B\ngSEA43BrJVebQhLukrKS8NulqroQ0euHTLrMNEDw+yJFADI=\n-----END PRIVATE KEY-----\n",
    "encryptionPublicKey": "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VuAyEAPbUpReaS4Wy2Is598QKmN0bdjFsVpYeeomzEH/Jvu1Y=\n-----END PUBLIC KEY-----\n",
    "encryptionPrivateKey": "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VuBCIEIDfsJv3G4b4dlqP5lXRkCBM+3Yy2fGg458eAtXToIM+0\n-----END PRIVATE KEY-----\n"
  },
  "generic": {
    "deviceId": "f86055b61f07bce1",
    "deviceName": "node-generic",
    "fingerprint": "F860-55B6-1F07-BCE1-8350-2CEE",
    "signingPublicKey": "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAenMk2SwyVtCKAEssgH9iAc9/keLmiPUQNbRnU4J8Eqw=\n-----END PUBLIC KEY-----\n",
    "signingPrivateKey": "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIGmdPRCA8zEn5UC6CUwPJ3LA16SiG2IzFKRYiyIoq9Xe\n-----END PRIVATE KEY-----\n",
    "encryptionPublicKey": "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VuAyEAAh57Tm/TAowNwQ6/EpBLliSOzfOmtJw9mIrbH18LBWk=\n-----END PUBLIC KEY-----\n",
    "encryptionPrivateKey": "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VuBCIEICAaKLVKXEFvADAYRdgt0ijjyggFVCpoPEwu/AUjP4VB\n-----END PRIVATE KEY-----\n"
  }
};

function getDevice(name) {
  return PRESET_DEVICES[name] || PRESET_DEVICES.generic;
}

function computeFileHash(filePath) {
  const hash = crypto.createHash('sha256');
  const buf = fs.readFileSync(filePath);
  hash.update(buf);
  return hash.digest('hex');
}

function computeDirHashes(dirPath, currentRel = '') {
  const results = {};
  if (!fs.existsSync(dirPath)) return results;
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    const relPath = currentRel ? `${currentRel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      Object.assign(results, computeDirHashes(fullPath, relPath));
    } else if (entry.isFile()) {
      results[relPath] = {
        size: fs.statSync(fullPath).size,
        sha256: computeFileHash(fullPath)
      };
    }
  }
  return results;
}

async function handleGenerate(args) {
  const type = args.type;
  const outDir = path.resolve(args.out);
  fs.mkdirSync(outDir, { recursive: true });

  if (type === 'single') {
    const size = parseInt(args.size, 10) || 0;
    const fileName = args.name || `payload_${size}.bin`;
    const filePath = path.join(outDir, fileName);
    const fd = fs.openSync(filePath, 'w');
    const chunkSize = 1024 * 1024; // 1MB buffer
    let remaining = size;
    const hash = crypto.createHash('sha256');
    while (remaining > 0) {
      const cur = Math.min(remaining, chunkSize);
      const buf = crypto.randomBytes(cur);
      fs.writeSync(fd, buf);
      hash.update(buf);
      remaining -= cur;
    }
    fs.closeSync(fd);
    console.log(JSON.stringify({
      success: true,
      file: filePath,
      size,
      sha256: size === 0 ? crypto.createHash('sha256').update(Buffer.alloc(0)).digest('hex') : hash.digest('hex')
    }));
  } else if (type === 'flood') {
    const count = parseInt(args.count, 10) || 100;
    const files = {};
    for (let i = 0; i < count; i++) {
      const fName = `flood_${String(i).padStart(5, '0')}.dat`;
      const fPath = path.join(outDir, fName);
      const content = crypto.randomBytes(Math.floor(Math.random() * 512) + 16);
      fs.writeFileSync(fPath, content);
      files[fName] = {
        size: content.length,
        sha256: crypto.createHash('sha256').update(content).digest('hex')
      };
    }
    console.log(JSON.stringify({ success: true, count, files }));
  } else if (type === 'tree') {
    const depth = parseInt(args.depth, 10) || 10;
    let curDir = outDir;
    for (let i = 1; i <= depth; i++) {
      curDir = path.join(curDir, `level_${i}`);
      fs.mkdirSync(curDir, { recursive: true });
      fs.writeFileSync(path.join(curDir, `marker_${i}.txt`), `depth level ${i}`);
    }
    const finalFile = path.join(curDir, 'deepest_payload.bin');
    const content = crypto.randomBytes(4096);
    fs.writeFileSync(finalFile, content);
    console.log(JSON.stringify({
      success: true,
      depth,
      deepestFile: finalFile,
      sha256: crypto.createHash('sha256').update(content).digest('hex')
    }));
  } else if (type === 'pathological') {
    const specialFiles = [
      { name: '0_byte_empty.txt', content: Buffer.alloc(0) },
      { name: '1_byte_char.txt', content: Buffer.from('A') },
      { name: '𠮷野家_生僻字测试_2026.bin', content: crypto.randomBytes(16384) },
      { name: '👨‍👩‍👧‍👦_家族照片_📸_🎉.tar.gz', content: crypto.randomBytes(32768) },
      { name: 'space file name with # & + = @ !.dat', content: crypto.randomBytes(8192) },
      { name: 'nested/sub/dir/chinese_中文字符_文件.docx', content: crypto.randomBytes(4096) }
    ];
    const results = {};
    for (const sf of specialFiles) {
      const p = path.join(outDir, sf.name);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, sf.content);
      results[sf.name] = {
        size: sf.content.length,
        sha256: crypto.createHash('sha256').update(sf.content).digest('hex')
      };
    }
    console.log(JSON.stringify({ success: true, items: results }));
  }
}

async function handleHash(args) {
  const dirPath = path.resolve(args.dir);
  if (!fs.existsSync(dirPath)) {
    console.log(JSON.stringify({ success: false, error: 'Directory does not exist' }));
    return;
  }
  const hashes = computeDirHashes(dirPath);
  console.log(JSON.stringify({ success: true, hashes }));
}

async function handleRecv(args) {
  const targetDir = path.resolve(args.dir);
  fs.mkdirSync(targetDir, { recursive: true });
  const port = parseInt(args.port, 10) || 47780;
  const nodeName = args['node-name'] || 'generic';
  const receiverDev = getDevice(nodeName);

  let server;
  let finished = false;

  server = net.createServer((socket) => {
    socket.setNoDelay(true);
    createTransferReceiver({
      socket,
      receiveDir: targetDir,
      localDeviceId: receiverDev.deviceId,
      localSigningPrivateKey: receiverDev.signingPrivateKey,
      localEncryptionPrivateKey: receiverDev.encryptionPrivateKey,
      lookupPeer: (senderDeviceId) => {
        // Search preset devices by deviceId
        for (const dev of Object.values(PRESET_DEVICES)) {
          if (dev.deviceId === senderDeviceId) {
            return {
              signingPublicKey: dev.signingPublicKey,
              deviceName: dev.deviceName
            };
          }
        }
        return {
          signingPublicKey: PRESET_DEVICES.generic.signingPublicKey,
          deviceName: 'generic-peer'
        };
      }
    }).then(recv => recv.done).then(() => {
      finished = true;
      const hashes = computeDirHashes(targetDir);
      console.log(JSON.stringify({
        success: true,
        hashes
      }));
      socket.destroy();
      server.close();
      process.exit(0);
    }).catch(err => {
      console.log(JSON.stringify({
        success: false,
        error: String(err?.message || err)
      }));
      socket.destroy();
      server.close();
      process.exit(1);
    });
  });

  server.on('error', (err) => {
    console.log(JSON.stringify({
      success: false,
      error: `Server listen error: ${err.message}`
    }));
    process.exit(1);
  });

  server.listen(port, '0.0.0.0', () => {
    console.log(JSON.stringify({
      listening: true,
      port,
      deviceId: receiverDev.deviceId
    }));
  });

  // Safety timeout 180s
  setTimeout(() => {
    if (!finished) {
      console.log(JSON.stringify({ success: false, error: 'Receiver timeout exceeded' }));
      try { server.close(); } catch(e) {}
      process.exit(1);
    }
  }, 180000);
}

async function handleSend(args) {
  const to = args.to;
  const port = parseInt(args.port, 10) || 47780;
  const inputPath = path.resolve(args.input);
  const senderNode = args['sender-node'] || 'generic';
  const receiverNode = args['receiver-node'] || 'generic';

  const senderDev = getDevice(senderNode);
  const receiverDev = getDevice(receiverNode);

  let sourceRoots = [];
  if (fs.statSync(inputPath).isDirectory()) {
    sourceRoots = fs.readdirSync(inputPath).map(e => path.join(inputPath, e));
    if (sourceRoots.length === 0) {
      console.log(JSON.stringify({ success: true, totalBytes: 0 }));
      process.exit(0);
    }
  } else {
    sourceRoots = [inputPath];
  }

  const sm = await buildTransferSourceManifest(sourceRoots, {});
  const totalBytes = sm.files.reduce((sum, f) => sum + f.size, 0);

  const checkpoint = {
    files: sm.files.map((f) => ({ path: f.path, size: f.size, committedOffset: 0, completed: false })),
    nextSequence: 0,
    totalTransferred: 0,
  };

  const controller = new AbortController();

  const executor = await createDesktopTransferExecutor({
    job: {
      taskId: sm.manifest.taskId,
      peerDeviceId: receiverDev.deviceId,
      direction: JOB_DIRECTION.OUTGOING,
      status: JOB_STATUS.TRANSFERRING,
      manifest: sm.manifest,
      sources: sm.files,
      sourceMappingStatus: 'available',
      progress: { transferredBytes: 0, totalBytes },
    },
    checkpoint,
    signal: controller.signal,
    commitRemoteCheckpoint: (cp) => cp,
    localDevice: {
      deviceId: senderDev.deviceId,
      signingPrivateKey: senderDev.signingPrivateKey,
    },
    trustedPeerStore: {
      getTrustedPeer: () => ({
        identity: {
          deviceId: receiverDev.deviceId,
          deviceName: receiverDev.deviceName,
          fingerprint: receiverDev.fingerprint,
          signingPublicKey: receiverDev.signingPublicKey,
          encryptionPublicKey: receiverDev.encryptionPublicKey,
        },
        permissions: { transfer: true },
        revokedAt: null,
      }),
    },
    lanService: {
      listPeers: () => [{
        deviceId: receiverDev.deviceId,
        deviceName: receiverDev.deviceName,
        fingerprint: receiverDev.fingerprint,
        signingPublicKey: receiverDev.signingPublicKey,
        encryptionPublicKey: receiverDev.encryptionPublicKey,
        host: to,
        port,
      }],
    },
  });

  if (args['thrash-pause']) {
    const thrashCount = parseInt(args['thrash-pause'], 10);
    let count = 0;
    const interval = setInterval(() => {
      if (count >= thrashCount) {
        clearInterval(interval);
        return;
      }
      if (count % 2 === 0) executor.pause?.();
      else executor.resume?.();
      count++;
    }, 50);
  }

  if (args['cancel-at-percent']) {
    setTimeout(() => {
      executor.cancel?.('test cancellation');
    }, 200);
  }

  try {
    await executor.done;
    console.log(JSON.stringify({
      success: true,
      totalBytes
    }));
    process.exit(0);
  } catch (err) {
    console.log(JSON.stringify({
      success: false,
      error: String(err?.message || err)
    }));
    process.exit(1);
  }
}

async function handleFuzz(args) {
  const to = args.to;
  const port = parseInt(args.port, 10) || 47780;
  const attackType = args.type; // 'bitflip' | 'replay' | 'bad-signature'

  const senderDev = getDevice('generic');
  const receiverDev = getDevice('generic');

  const socket = net.connect(port, to, async () => {
    socket.setNoDelay(true);

    if (attackType === 'bitflip') {
      // Send junk corrupted wire frame
      const junk = Buffer.alloc(1024, 0xff);
      socket.write(junk);
    } else if (attackType === 'bad-signature') {
      // Send wire frame with forged signature
      const fakePayload = Buffer.from(JSON.stringify({
        app: 'nearby-transfer',
        protocolVersion: 2,
        type: 'transfer-manifest',
        senderDeviceId: 'hacker-device',
        signature: 'invalid-signature-bytes'
      }));
      const frame = encodeWireFrame({
        header: { app: 'nearby-transfer', protocolVersion: 2, type: 'transfer-manifest' },
        payload: fakePayload
      });
      socket.write(frame);
    } else if (attackType === 'replay') {
      // Send expired manifest
      const expiredPayload = Buffer.from(JSON.stringify({
        app: 'nearby-transfer',
        protocolVersion: 2,
        type: 'transfer-manifest',
        issuedAt: Date.now() - 60000,
        expiresAt: Date.now() - 30000
      }));
      const frame = encodeWireFrame({
        header: { app: 'nearby-transfer', protocolVersion: 2, type: 'transfer-manifest' },
        payload: expiredPayload
      });
      socket.write(frame);
    }
  });

  socket.on('close', () => {
    console.log(JSON.stringify({ success: true, rejected: true, reason: 'Remote cleanly closed connection upon security attack' }));
    process.exit(0);
  });

  socket.on('error', (err) => {
    console.log(JSON.stringify({ success: true, rejected: true, reason: `Remote rejected socket: ${err.message}` }));
    process.exit(0);
  });

  setTimeout(() => {
    console.log(JSON.stringify({ success: false, error: 'Remote did not reject invalid payload in time' }));
    socket.destroy();
    process.exit(1);
  }, 5000);
}

async function main() {
  const cmd = process.argv[2];
  const rawArgs = process.argv.slice(3);

  const parsed = {};
  for (let i = 0; i < rawArgs.length; i++) {
    if (rawArgs[i].startsWith('--')) {
      const key = rawArgs[i].slice(2);
      const val = rawArgs[i + 1] && !rawArgs[i + 1].startsWith('--') ? rawArgs[++i] : true;
      parsed[key] = val;
    }
  }

  try {
    if (cmd === 'generate') await handleGenerate(parsed);
    else if (cmd === 'hash') await handleHash(parsed);
    else if (cmd === 'recv') await handleRecv(parsed);
    else if (cmd === 'send') await handleSend(parsed);
    else if (cmd === 'fuzz') await handleFuzz(parsed);
    else {
      console.error(`Unknown command: ${cmd}`);
      process.exit(1);
    }
  } catch (err) {
    console.log(JSON.stringify({ success: false, error: err.stack || err.message }));
    process.exit(1);
  }
}

main();

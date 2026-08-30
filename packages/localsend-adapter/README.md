# @luo-5/localsend-adapter

LocalSend protocol interop adapter for Nearby Transfer.

Enables file exchange between Nearby Transfer and [LocalSend](https://localsend.org/) apps on the LAN.

The current adapter advertises LocalSend's HTTP transport. It provides interoperability,
not Nearby Transfer protocol-v2 end-to-end encryption. Use it only on networks whose
confidentiality boundary you understand.

## Install

```bash
npm install @luo-5/localsend-adapter
```

## Usage

```typescript
import path from 'node:path';
import {
  LocalSendDiscovery,
  LocalSendReceiver,
  buildFileSpec,
  sendFiles,
  type LocalSendDevice,
  type LocalSendDeviceInfo,
  type LocalSendUploadApproval,
} from '@luo-5/localsend-adapter';

const fingerprint = 'replace-with-a-stable-device-fingerprint';
const discovery = new LocalSendDiscovery({ alias: 'My Device', fingerprint, port: 53317 });
const targetPromise = new Promise<LocalSendDevice>((resolve) => discovery.once('peer', resolve));

const receiver = new LocalSendReceiver({
  port: 53317,
  alias: 'My Device',
  fingerprint,
  receiveDir: path.resolve('received'),
  authorizeUpload: async (request: LocalSendUploadApproval) => {
    console.log(`Incoming files from ${request.sender.alias}:`, request.files.map((file) => file.fileName));
    // Replace this fail-closed example with an explicit local user prompt or a
    // trusted-device/PIN decision in your application.
    return false;
  },
});

const senderInfo: LocalSendDeviceInfo = {
  alias: 'My Device',
  version: '2.0',
  deviceModel: 'Node.js',
  deviceType: 'desktop',
  fingerprint,
  port: 53317,
  protocol: 'http',
  download: false,
  announce: true,
};

try {
  discovery.start();
  await receiver.start();
  const targetDevice = await targetPromise;
  await sendFiles({
    device: targetDevice,
    files: [buildFileSpec(path.resolve('photo.jpg'), 'photo-1')],
    senderInfo,
  });
} finally {
  discovery.stop();
  await receiver.stop();
}
```

## Receiver safety

The receiver treats LocalSend manifests and uploads as untrusted input. It rejects
unsafe file names and IDs, writes uploads to server-generated temporary paths, and
publishes completed files without overwriting an existing destination.

Incoming uploads are denied by default. Applications must provide an
`authorizeUpload` callback and return `true` after a local approval, trusted-device,
or PIN check. Approval has a bounded timeout, and rejected requests do not allocate
an upload session or temporary directory.

Resource limits are enabled by default for request bodies, file and session sizes,
pending sessions, concurrent uploads, and session lifetime. They can be adjusted with
`requestBodyLimitBytes`, `maxFileSizeBytes`, `maxSessionSizeBytes`,
`maxFilesPerSession`, `maxSessions`, `maxSessionsPerIp`, `maxConcurrentUploads`,
`sessionTimeoutMs`, `approvalTimeoutMs`, and `requestBodyTimeoutMs`.
Cancelled, expired, and stopped sessions remove their temporary upload data.

The sender streams file contents with backpressure and bounds connection, idle, and
response-body resources through `connectTimeoutMs`, `idleTimeoutMs`, and
`maxResponseBodyBytes`. HTTPS peers are authenticated by comparing the SHA-256 of
the presented certificate with the fingerprint from LocalSend discovery; mismatches
are rejected before any request body is sent. Plain HTTP remains unencrypted and
should only be used on a network whose confidentiality boundary you accept.

## License

MIT

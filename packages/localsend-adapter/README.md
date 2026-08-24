# @luo-5/localsend-adapter

LocalSend protocol interop adapter for Nearby Transfer.

Enables file exchange between Nearby Transfer and [LocalSend](https://localsend.org/) apps on the LAN.

## Install

```bash
npm install @luo-5/localsend-adapter
```

## Usage

```typescript
import { LocalSendDiscovery, LocalSendReceiver, sendFiles } from '@luo-5/localsend-adapter';

// Discover LocalSend devices
const discovery = new LocalSendDiscovery({
  alias: 'My Device',
  fingerprint: 'my-fingerprint',
  port: 53317,
});
discovery.on('peer', (device) => console.log('Found:', device.alias));
discovery.start();

// Receive files from LocalSend senders
const receiver = new LocalSendReceiver({
  port: 53317,
  alias: 'My Device',
  fingerprint: 'my-fingerprint',
  receiveDir: '/tmp/received',
});
await receiver.start();

// Send files to a LocalSend device
await sendFiles({
  device: targetDevice,
  files: [{ id: '1', fileName: 'photo.jpg', filePath: '/path/to/photo.jpg', size: 1024 }],
  senderInfo: { alias: 'My Device', fingerprint: 'my-fingerprint', port: 53317, /* ... */ },
});
```

## License

MIT

# Protocol

## Discovery

Nearby Transfer apps announce themselves with UDP multicast.

- Multicast address: `239.255.77.77`
- Port: `47777`
- Interval: 2 seconds
- Peer timeout: 10 seconds

Each announcement contains the device ID, device name, transfer port, identity fingerprint, and public encryption key.

## Transfer Request

The sender opens a local-network HTTP request to the receiver. File bytes are encrypted at the application layer before they enter the HTTP request body.

```text
POST /transfer/request
```

The request includes file metadata, sender metadata, a sender ephemeral X25519 public key, and an Ed25519 signature over those fields. The receiver verifies the signature, derives the shared transfer key, and shows a confirmation dialog. The file is not uploaded unless the receiver accepts.

## Upload

After acceptance, the sender uploads encrypted chunk frames:

```text
POST /transfer/upload/:transferId
```

Each encrypted frame is encoded as:

```text
4 bytes  ciphertext length, big endian
12 bytes AES-GCM IV
16 bytes AES-GCM auth tag
N bytes  ciphertext
```

The receiver decrypts each frame, writes to a temporary file, verifies the final SHA-256 hash, and then moves the file into the configured receive directory.

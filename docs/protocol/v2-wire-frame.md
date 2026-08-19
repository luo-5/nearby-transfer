# Protocol v2 wire frame

This document defines the transport-independent binary frame used by Nearby
Transfer protocol v2 after a connection has been authenticated. It does not
open sockets, encrypt bytes, or authorize a message. The connection layer must
perform those steps before giving data to application message handlers.

## Limits

| Limit | Value |
| --- | ---: |
| Maximum complete frame body | 16 MiB (16,777,216 bytes) |
| Maximum UTF-8 JSON header | 16 KiB (16,384 bytes) |
| Maximum decoder buffer | 16 MiB + 4 bytes |

The bounded decoder rejects input that would exceed its buffer limit rather
than retaining unbounded network data. Transports should use ordinary bounded
read sizes. A caller receiving end-of-stream must call `finish()`; any
remaining prefix or body bytes are a protocol truncation error.

## Binary layout

All integer fields are unsigned big-endian. `frameLength` counts every byte
following itself, including `headerLength`, the header, and payload.

```text
0                   3 4                 5 6
+---------------------+-------------------+-------------------...
| frameLength (u32)   | headerLength(u16) | canonical header | payload
+---------------------+-------------------+-------------------...
```

A frame body must contain at least the two-byte `headerLength` field. The
header length must be from 1 through 16,384 and fit fully inside the declared
frame body. The payload is optional and is the remaining bytes; its length is
not separately sender-controlled.

## Canonical header

The header is strict UTF-8 and must be byte-for-byte equal to the repository's
restricted canonical JSON serialization. UTF-8 decoding is fatal; invalid byte
sequences and a leading UTF-8 BOM are rejected. Whitespace, a different key
order, duplicate JSON keys, a textual numeric version, decimal numbers, and
other non-canonical representations are rejected.

The header has exactly these fields, with no extension fields:

```json
{
  "app": "nearby-transfer",
  "protocolVersion": 2,
  "type": "transfer-chunk"
}
```

- `app` is exactly `nearby-transfer`.
- `protocolVersion` is the safe integer `2`.
- `type` must be one of the current `MESSAGE_TYPES` constants:
  `discovery-announce`, `pairing-offer`, `pairing-confirm`, `pairing-cancel`,
  `transfer-manifest`, `transfer-chunk`, `transfer-complete`, or
  `library-session`.

Message-specific data belongs in the payload or in a later authenticated
message schema; it is not silently accepted as an unknown generic header
field. This makes every future header extension an explicit protocol change.

## Desktop API

`src/v2/wire-frame.js` exposes:

- `encodeWireFrame({ header, payload? })` -> one `Buffer`;
- `decodeWireFrame(buffer)` -> exactly one `{ header, payload }` object;
- `new WireFrameDecoder()` with `push(chunk)` and `finish()` for stream input.

`payload` and decoder chunks must be a Node.js `Buffer` or `Uint8Array`. The
returned payload is copied from the decoder buffer. `push()` may return zero,
one, or multiple frames, supporting split and coalesced TCP/TLS/QUIC reads.

This layer intentionally has no plaintext transport use on its own. Future
connection code must bind frames to a mutually authenticated, replay-protected
session and authorize each message type against the trusted-peer store.
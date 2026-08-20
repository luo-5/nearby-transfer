# Nearby Transfer v1.0 plan

## Goal

Upgrade the MVP into a Windows + Android, LAN-only, trusted-device transfer
tool with encrypted multi-file transfers, resumable jobs, compact mobile UI,
and a desktop-only, explicitly enabled WebDAV library. Protocol v2 is
incompatible with v0.x; existing peers must pair again.

## Milestones

1. Foundation: protocol v2, shared fixtures, desktop module boundaries,
   Android Kotlin/Room foundations, and migration documentation.
2. Trusted devices: pairing, six-digit comparison confirmation, trust records,
   permissions, revocation, rename, and online/offline device views.
3. Recoverable transfer: multi-file/folder manifests, authenticated encrypted
   chunks, queue/pause/retry/cancel, durable checkpoints, and restart recovery.
4. File library: desktop-only, manually enabled WebDAV with per-device and
   per-directory read/upload grants. No anonymous access or destructive remote
   operations.
5. Release hardening: compact Android UI, diagnostics, packaging, upgrade
   notes, security review, and Windows + Android release-candidate testing.

## Product and security boundaries

- LAN only; no accounts, cloud metadata, relays, NAT traversal, or public
  sharing.
- Discovery is reachability information, never authorization.
- Transfer and library access require a paired identity and explicit grant.
- Receive paths reject traversal, symlinks/reparse escapes, collisions, unsafe
  names, and Windows reserved device names.
- A receiver checkpoint is authoritative only after decrypt, staging write,
  `force()`, and the Room transaction all succeed.
- The sender uses stop-and-wait progress acknowledgements until a later,
  separately tested pipelining design is introduced.
- Empty files are represented as explicit durable completion markers.

## Acceptance matrix

- Windows to Android and Android to Windows pairing and transfer.
- Rejection, cancellation, revoked trust, changed identity, and impersonation.
- Multiple files, nested folders, empty files, Chinese/English names, long
  names, and Windows reserved names.
- Disconnect, retry, process restart, device offline/online, and stale ACKs.
- Hash mismatch, size mismatch, insufficient space, denied permissions, and
  partial publication recovery.
- WebDAV read-only, upload-only, expiry, shutdown, and unpaired rejection.
- Node smoke tests, Android JVM/UI tests, shared fixtures, desktop packaging,
  and at least one real-device regression round.

## Explicitly deferred

SMB, third-party WebDAV client compatibility, public access, cloud sync,
remote delete/rename/move/overwrite, and Android as a WebDAV server are later
milestones and should not expand the current transfer implementation.

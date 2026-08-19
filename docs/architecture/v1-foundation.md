# v1.0 foundation architecture

## Purpose

This document fixes the module boundaries before the user interface and
network features are rewritten. It is deliberately incremental: the existing
v0.x implementation continues to be the runnable baseline until a complete
v2 vertical slice replaces it.

## Desktop process boundaries

```text
Electron main process
  ├─ identity and trusted-peer store
  ├─ discovery and pairing session service
  ├─ transfer scheduler and resumable transfer store
  ├─ desktop file-library/WebDAV service
  └─ narrow IPC facade

Electron renderer
  ├─ Devices
  ├─ Transfers
  ├─ File library
  └─ Settings
```

The renderer must not obtain private keys, arbitrary filesystem paths, server
sockets, or unrestricted IPC. Each main-process operation uses an explicit,
validated request/response contract.

## Durable data

Desktop will migrate from `device.json` to a versioned SQLite database using the Electron runtime's `node:sqlite` support while
retaining the current local identity. Android will use the corresponding Room
schema. The first schemas are:

- `trusted_peers`: public identity, display name, trust state, permissions,
  timestamps, and revocation metadata;
- `pairing_sessions`: bounded, expiring bootstrap state only;
- `transfer_jobs`, `transfer_items`, and `transfer_chunks`: resumable state and
  non-sensitive diagnostics;
- `shared_libraries` and `library_grants`: desktop-only directory configuration
  and per-peer permissions.

The initial trusted-peer and pairing-session schemas are implemented in
`src/v2/trusted-peer-store.js` and `src/v2/pairing-session-store.js`. The
pairing service limits active sessions, expires them after five minutes, and
accepts remote confirmation only after signature, identity, code, and freshness
validation. Private identity keys remain in platform-appropriate protected
storage where possible; database rows contain references or encrypted material,
never UI exports.

## Compatibility and rollout

- Keep `release/0.2.0-integration` buildable throughout the migration.
- Build v2 behind a dedicated `next/1.0` branch and add vertical slices rather
  than a half-finished replacement of every screen.
- v2 does not interoperate with v0.x. A v2 device must provide a clear upgrade
  indication rather than silently attempting a downgrade.
- Shared protocol fixtures are mandatory for desktop/Android changes that
  affect signed data or cryptographic derivation.

## Initial implementation order

1. Protocol contract, canonical encoder, and cross-platform vectors.
2. Trusted-peer persistence and pairing session state.
3. Authenticated v2 discovery plus QR bootstrap.
4. Transfer manifest, scheduler, and resumable encrypted chunks.
5. Desktop-only file-library server and client views.
6. React/Vite and Compose UI migrations over stable domain interfaces.

The last item intentionally follows stable domain APIs: a visual rewrite must
not redefine security or file-system behavior.

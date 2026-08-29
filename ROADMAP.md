# Roadmap

This roadmap tracks intended work, not promised release dates. Capability status is
authoritative in [`docs/capabilities.md`](docs/capabilities.md).

## Now: trustworthy baseline

- Keep Node 24 desktop/package verification green on Linux, Windows, and macOS.
- Keep Android unit tests and debug builds as pull-request gates for Android changes.
- Merge receive-boundary and protocol-availability fixes.
- Make README, security documentation, release notes, and package contents match the
  code and published assets.
- Separate application, npm package, container, and Android release boundaries.

## Next: complete one secure v2 path

- Connect v2 pairing and trusted-peer permissions to the desktop send/receive data
  path without silently falling back to discovered keys.
- Make CLI pairing/trust persistent and mutually verified, or keep transfer commands
  explicitly experimental and fail closed.
- Complete durable checkpoint ownership, crash recovery, cancellation, replay, and
  resource-limit tests across sender and receiver.
- Validate Android v2 lifecycle, recovery, and publication on real devices in addition
  to JVM tests.
- Publish a reproducible patch release with checksums, SBOM, provenance, and accurate
  signing status.

## Later: expand verified interoperability

- Promote additional protocol drivers only after complete send/receive integration,
  threat modeling, limits, documentation, and cross-client tests.
- Add protected Windows code signing and Android release signing; add macOS only with
  signing and notarization.
- Work with upstream interoperability projects and publish compatibility fixtures.
- Grow contributor documentation, good-first issues, and independent downstream use.

## Not currently promised

QUIC, SMB, FTPS, WAN relay/WebRTC, macOS releases, app-store distribution, and every
Linux package format are exploratory. Their presence in code scaffolding or planning
documents is not a shipping commitment.

# Repository Guidelines

These instructions apply to the entire repository.

## Project Layout

- `src/` contains the Electron desktop application.
- `src/core/` contains the legacy transfer, discovery, crypto, and filesystem code.
- `src/v2/` contains protocol-v2 codecs, pairing, trust, persistence, and transfer sessions.
- `src/renderer/` contains the desktop UI. Keep privileged operations behind IPC APIs in
  `src/main.js` and `src/preload.js`.
- `android-app/` contains the native Android client. Java classes currently host the legacy
  application flow; Kotlin packages under `core/` and `feature/` contain the migration
  foundations and persistent v2 services.
- `test/` contains dependency-light Node smoke tests. Android unit tests live under
  `android-app/src/test/`.
- `docs/protocol/` is the protocol reference. Shared fixtures under `test/fixtures/` are the
  cross-platform compatibility contract.

## Development Environment

- Use Node.js 20 or newer and install desktop dependencies with `npm ci`.
- Use Java 17, Android SDK platform 35, and the checked-in Gradle Wrapper for Android work.
- Do not depend on a globally installed Gradle distribution.
- Keep source files in their existing language and style. Do not introduce a formatter that
  rewrites unrelated files.

## Required Verification

Run the desktop checks for any JavaScript, renderer, protocol, or shared-fixture change:

```bash
npm run check
npm test
```

Run Android unit tests for any Android or shared-fixture change:

```powershell
.\gradlew.bat :android-app:testDebugUnitTest
```

Build the debug APK when Android source, resources, the manifest, Gradle configuration, or
Room schemas change:

```powershell
.\gradlew.bat :android-app:assembleDebug
```

On Linux and macOS, use `./gradlew` instead of `gradlew.bat`. Record any test that cannot run
and the reason in the pull request.

## Protocol And Security Rules

- Treat all network announcements, request metadata, frame lengths, identifiers, filenames,
  and persisted records as untrusted input. Validate type, size, bounds, and canonical form
  before allocating memory, opening files, or changing state.
- Preserve desktop/Android protocol compatibility. When wire behavior changes, update the
  protocol documentation, both implementations where applicable, and shared fixtures.
- Do not weaken authenticated encryption, signature verification, key/fingerprint binding,
  replay protection, transfer size checks, or final plaintext hash verification.
- Keep filesystem writes confined to validated receive or staging roots. Reject traversal,
  symlink/reparse-point escapes, unsafe filenames, and ambiguous ownership.
- Never log or commit real private keys, pairing secrets, file contents, credentials, signing
  material, or other sensitive payloads. Clearly marked deterministic protocol test vectors
  may contain non-production key material.
- Bound network concurrency, request sizes, timeouts, and pending user decisions. Shutdown
  paths must release sockets, workers, locks, streams, and temporary files.

## Persistence And Recovery

- Preserve backward compatibility for stored desktop JSON and Android Room data unless a
  documented migration is supplied.
- Update exported Room schemas and migration tests whenever the database schema changes.
- Recovery and resume state must move monotonically. A stale checkpoint must not overwrite a
  newer one, and cancellation must propagate without being converted into a retryable error.
- Publication must remain recoverable and idempotent across process death. Do not delete the
  only durable source before the destination has been sealed and journaled.

## Testing Expectations

- Add focused regression coverage for fixes, including malformed input and failure paths.
- Include lifecycle tests for start/stop/restart behavior and cleanup after partial failure.
- Include race or concurrency tests when changing allocation, scheduling, persistence, or
  connection handling.
- Prefer deterministic local tests. Do not make the default test suite depend on LAN peers,
  external services, real user data, or release credentials.
- Real-device transfer testing supplements automated tests; it does not replace them.

## Commits And Pull Requests

- Use focused Conventional Commit subjects such as `feat(v2): ...`, `fix(android): ...`,
  `test(desktop): ...`, or `docs: ...`.
- Keep generated dependencies, build output, APKs, installers, logs, local SDK paths, and test
  scratch directories out of commits.
- Update documentation when behavior, compatibility, persistence, build steps, or security
  assumptions change.
- In the pull request, summarize behavior changes, list verification commands and results,
  and call out protocol, migration, packaging, or platform-specific risk.

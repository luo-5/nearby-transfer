# v1.0 development handoff

This document is the handoff point for the large v1.0 rewrite. The repository
is intentionally still a Draft PR and the production transfer composition roots
are not enabled yet.

## Repository state

- Upstream: `https://github.com/luo-5/nearby-transfer`
- Working branch: `next/1.0`
- Draft PR: `https://github.com/luo-5/nearby-transfer/pull/9`
- Latest pushed commit: `aa00759`
- Protocol: v2, intentionally incompatible with v0.x
- Required commit trailer for future commits:

```text
Co-authored-by: Codex <codex@openai.com>
```

Keep the PR as Draft until the Android runtime is wired and the real Windows to
Android transfer matrix has passed.

## What is implemented in this batch

Commit `aa00759` adds the receiver-authoritative resumability foundation:

- Desktop SQLite stores `checkpoint_next_sequence` and a complete outgoing
  checkpoint in one transaction.
- Desktop scheduler passes `checkpoint` into the executor and exposes
  `commitRemoteCheckpoint(checkpoint, now)`.
- Bootstrap now requires an accepted decision followed by a signed,
  same-session `transfer-resume` frame.
- Resume frames and progress acknowledgements carry a canonical 16-byte
  `sessionId`; the persistent checkpoint deliberately does not store that
  session ID so a retry gets a fresh session.
- Resume/progress file records carry `completed`, which distinguishes an empty
  file that has been durably acknowledged from one that has not.
- Desktop encrypted chunk reading consumes the complete checkpoint and skips
  completed files, including completed empty files.
- The stream session uses a bounded kind-3 progress frame and stop-and-wait:
  the sender cannot send the next chunk until the receiver's signed progress
  has been verified and the desktop checkpoint transaction has committed.
- Android has matching message validation, shared fixture tests, a durable
  acknowledgement encoder, and the receiving stream session. The runtime
  encoder is not yet connected to `V2IncomingTransferCoordinator`.
- Legacy persisted outgoing jobs are migrated so unfinished empty files are not
  incorrectly marked complete.

## Verification already run

Desktop:

```powershell
npm run check
npm test
```

Both pass. The test suite prints one expected Windows symlink skip when the
process lacks permission to create symlinks.

Android, with Java 17 and Android SDK 35:

```powershell
.\gradlew.bat :android-app:testDebugUnitTest :android-app:assembleDebug --rerun-tasks --no-daemon
```

This passes. The Debug APK is generated under
`android-app/build/outputs/apk/debug/`; it is a local artifact and should not
be committed.

## What remains before real-device testing

1. Add an Android receive runtime that owns the detached socket, derives the
   X25519 session key, loads Room checkpoint state, and maps Android
   `V2EncryptedChunkWriter.Progress` to `V2TransferAcknowledgementCodec`.
2. Add a Java-callable Room persistence facade that loads and atomically commits
   receive checkpoints without opening a new database for every chunk.
3. Change the coordinator handoff to prepare the runtime before sending
   `accepted`; a successful decision must never be sent when staging, keys,
   publication, or checkpoint initialization cannot be prepared.
4. Wire `V2PairingController` and `MainActivity` with an opt-in transfer
   handler and the `transfer` capability. Keep private keys and session keys
   outside Activity/UI objects.
5. Add publication integration: seal staging, journal the publication plan,
   publish through the existing MediaStore/SAF coordinator, clean staging, and
   finalize the Room job idempotently.
6. Add one end-to-end Node/Android interoperability test using a local socket
   harness, then test on Windows and an unlocked Android device.

Do not enable the production transfer route before these steps. The current
desktop and Android protocol classes are safe to test in isolation, but the
Android detached-socket runtime boundary is intentionally still closed.

## Recommended next implementation split

- `V2IncomingTransferRuntime.java`: runtime ownership, crypto derivation,
  writer/session construction, bounded executor and close behavior.
- `V2ReceiveRuntimePersistence.kt`: Java-friendly Room snapshot/checkpoint
  facade with monotonic transactional commits.
- `V2PublicationRuntime.kt`: publication and cleanup facade around the existing
  publication journal/coordinator.
- `V2IncomingTransferCoordinator.java`: prepare-before-accepted handoff and
  recoverable-task lookup.
- `V2PairingController.java` and `MainActivity.java`: production composition
  root only after runtime tests pass.

Keep these writes disjoint where possible. The protocol schema and desktop
checkpoint APIs are already in the working tree, so new work should build on
them instead of creating a second checkpoint format.

## Moving the directory to another computer

Copy the repository directory including `.git`, `AGENTS.md`, `docs/`,
source, tests, `package-lock.json`, and the Gradle wrapper. Do not copy local
caches or generated output:

- `node_modules/`
- `.gradle/`, `.kotlin/`
- `android-app/build/`
- `.tmp/`, local SDK/JDK directories, APKs, screenshots, and installers

On the new computer:

```powershell
git status
git log --oneline --decorate -5
npm ci
npm run check
npm test
```

For Android, install Java 17 and Android SDK platform 35/build tools 35.0.0,
then run:

```powershell
.\gradlew.bat :android-app:testDebugUnitTest :android-app:assembleDebug --no-daemon
```

The source tree must not rely on the old absolute paths under
`C:\Users\31752\Desktop\pr`. Android toolchain paths are environment
configuration only; set `JAVA_HOME` and `ANDROID_HOME` on the new computer.

## Safe handoff checklist

- [x] Commit and push the current verified batch with the Codex trailer.
- [ ] Confirm the Draft PR shows the new commit and no conflicts.
- [ ] Continue from `next/1.0`, not from an old PR branch.
- [ ] Keep Android transfer production wiring disabled until runtime tests pass.
- [ ] Run the full Node and Android commands after every protocol/runtime batch.
- [ ] Before real-device testing, test rejection, revoked trust, disconnect,
  process restart, empty files, multiple files, Chinese paths, and Windows
  reserved names.

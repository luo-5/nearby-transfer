# Publication recovery design

> Status: proposed, not implemented.
>
> This document is an internal engineering design, not release evidence. The current
> Core, CLI, and desktop application do **not** implement the complete state machine
> below. Until the implementation, migrations, startup recovery, and crash tests are
> complete on the supported platforms, the project must not claim complete publication
> recovery, transactionally atomic multi-root publication, or restart-safe incoming
> transfer resume.

## Purpose and scope

This design defines how a fully received and verified protocol-v2 transfer can be
published into a user-selected destination without overwriting existing content and
without losing the only durable copy after a process or machine failure. It preserves
multi-file and directory transfers.

The design separates three properties that must not be conflated:

1. **Receive durability**: acknowledged chunks exist in durable staging.
2. **Publication recovery**: an interrupted publication can be inspected and safely
   resumed without repeating or undoing an unknown side effect.
3. **Atomic visibility**: users observe either the whole transfer or none of it.

The minimum implementation in this document provides the first two properties. Atomic
visibility for multiple independent top-level roots is not generally available through
portable filesystem APIs. A single-container mode can provide it only when the selected
backend has a real atomic no-replace primitive.

This proposal does not change the protocol-v2 wire format. It does not retrofit the
classic desktop protocol, make the CLI pairing flow complete, or promise resume of a
partially received file before incoming checkpoint persistence is implemented.

## Current implementation boundary

The implementation must be attached at the real ownership boundaries rather than added
as a disconnected recovery utility.

| Component | Current behavior | Required integration point |
| --- | --- | --- |
| Core target planner | `planReceiveTargets()` creates a task staging directory under the receive root and reserves conflict-free top-level names. Reservations are process-independent filesystem entries, but there is no durable publication transaction record. | Return an immutable root-level publication plan and create the durable journal before the receiver accepts the transfer. |
| Core encrypted writer | `createEncryptedChunkWriter()` verifies files and `complete()` calls `publishAllRoots()`. Top-level roots are published sequentially. Regular-file roots use a hard link and then normally remove the staging link; directory roots use `rename()`, which consumes staging. Rollback state exists only in memory. | Replace the in-memory publication loop with a journal-driven coordinator. Keep verified staging until the aggregate commit is durable. |
| Core receiver | `createTransferReceiver()` owns planning, writer creation, stream completion, cancellation, and staging cleanup. It currently sends a zero-progress resume message and does not persist incoming progress or publication state. | Inject a publication store/coordinator, create the journal after planning and before acceptance, seal it after final verification, and distinguish cleanup-before-commit from cleanup-after-commit. |
| Core `TransferJobStore` | The TypeScript JSON store persists jobs and outgoing checkpoints, but the current Core receiver is not wired to an incoming job row. | Do not assume this store already protects incoming publication. Add an explicit publication-store interface; a later composition may store publication state alongside incoming jobs. |
| CLI receive command | `packages/cli/src/commands/receive.ts` calls `createTransferReceiver()` directly and tracks active receivers only in process memory. | Construct a file-backed publication store under the CLI data directory, run recovery before listening, and pass the store to each receiver. |
| Desktop application | The current desktop data path uses `src/core/server.js` and the classic protocol. `src/v2/encrypted-chunk-writer.js` and related files re-export the vendored Core implementation. `src/main.js` creates the separate SQLite v2 job store for APIs, but does not run the Core v2 receiver publication path. | Keep classic behavior unchanged. Wire the publication coordinator only when the desktop v2 incoming data path is actually enabled, using an application-owned store under `userData`. |
| Android | The Room-backed `V2PublicationCoordinator` already uses durable intent, backend side effect, inspection, and durable receipt per file, and truthfully represents partial publication. | Reuse its ordering model. Add an aggregate commit/cleanup gate where needed; do not weaken its provider inspection or claim cross-file atomicity. |

Consequently, adding a journal class to Core alone is insufficient. CLI startup recovery
and the future desktop v2 receiver must invoke it. The classic desktop server must not be
described as covered by this design.

## Required invariants

Every implementation and test must preserve these invariants:

- A destination selected by the planner is never replaced by publication.
- A backend side effect is preceded by a durable intent and followed by a durable,
  content-bound receipt.
- A receipt is monotonic and idempotent. The same operation may be observed repeatedly,
  but it may be committed only once.
- A conflicting receipt, target token, filesystem identity, size, tree shape, or digest
  moves the transaction to `RECONCILE_REQUIRED`; it is never guessed away.
- Verified staging is retained until the task-level `COMMITTED` record is durable.
- Once any root may be user-visible, automatic recovery rolls forward. It does not delete
  a published root as compensation.
- `COMMITTED` is the publication commit point. Cancellation after that point cannot turn
  the transfer into a failure or remove published content.
- Cleanup is idempotent, best-effort after commit, and separately journaled. Cleanup
  failure does not falsify a successful publication.
- Terminal task and root states never regress.
- Unknown journal versions, malformed records, missing ownership proof, and unsafe
  symlink/reparse-point trees fail closed.

## Publication modes

### Persistent per-root publication (minimum portable design)

The default plan retains the original top-level layout. Each top-level manifest root is
published independently under a durable journal. The user can temporarily observe a
partial set of roots on backends without an atomic batch primitive, but recovery is
truthful and does not lose or overwrite data.

This is the smallest reliable change compatible with existing manifests and destination
layout. It also matches Android's existing per-file publication model.

### Single-container atomic publication (optional capability)

All manifest roots can instead be placed under one generated destination directory, for
example `Transfer 2026-08-30/`. A complete hidden ready tree is built beside the final
destination, then one no-replace rename exposes the container.

This mode has stronger visibility semantics but changes the destination layout. It also
requires all of the following:

- ready and final paths are on the same filesystem;
- the backend exposes a true atomic no-replace directory rename;
- the filesystem supports that primitive for the selected paths;
- the ready tree is durable and verified before the rename;
- recovery can prove that an ambiguous final container belongs to the operation.

If any condition is absent, the backend must either use persistent per-root publication
and report partial visibility, or fail with an explicit unsupported-capability result.
It must not silently fall back to a check-then-rename sequence while calling it atomic.

Publishing a single archive file can use regular-file no-replace primitives more widely,
but changes the product result from an expanded directory tree to an archive. It is not
the default proposed here.

## Durable data model

Core should define interfaces and validation in the package while leaving storage to the
host:

```ts
interface PublicationStore {
  create(plan: PublicationPlan): Promise<PublicationRecord>;
  load(publicationId: string): Promise<PublicationRecord | null>;
  compareAndSet(
    publicationId: string,
    expectedRevision: number,
    next: PublicationRecord,
  ): Promise<boolean>;
  listRecoveryWork(): Promise<PublicationRecord[]>;
}
```

The first CLI implementation may use versioned JSON records written as a temporary file,
file-synced, renamed over the previous record, and followed by a best-effort parent
directory sync. The future desktop v2 implementation should use a SQLite transaction and
a schema migration in its application-owned database. Core must not write application
state into an implicit home directory.

A publication record contains only validated data:

```text
schemaVersion
publicationId                 stable, derived once and persisted
taskId
manifestHash
receiveRoot                   normalized absolute root
receiveRootIdentity           backend-specific identity when available
mode                          per-root | single-container
state
revision
cancelRequested
cleanupPending
createdAt / updatedAt
stagingRelativePath
roots[]
  rootId                      stable index plus manifest-relative root
  operationId                 deterministic within this publication
  sourceRelativePath
  finalRelativePath
  expectedKind
  expectedTreeHash
  state
  method                      unset | link | native-no-replace-rename | owned-copy
  intentRevision
  receipt                     nullable
    operationId
    targetToken               opaque backend identity
    targetIdentity            dev/inode or provider identity when reliable
    observedTreeHash
    observedSize
    committedAt
  lastError                   bounded diagnostic, never file contents or secrets
```

Absolute paths are reconstructed only after validating the stored receive root and every
relative component. A moved or replaced receive root requires reconciliation. The record
must be validated as strictly as a network manifest before filesystem access.

The `operationId` should be a deterministic digest of the publication ID, root ID,
manifest hash, and schema version. It is an idempotency key, not an authorization secret.

## State machines

### Aggregate transaction

```text
PLANNED
  -> RECEIVING
  -> SEALED
  -> PUBLISHING
  -> COMMITTED
  -> CLEANUP_PENDING
  -> DONE

PLANNED | RECEIVING -> CANCELLED
SEALED               -> CANCELLED, if no root side effect has started
PUBLISHING            -> PUBLISHING with cancelRequested, then roll forward
any nonterminal       -> RECONCILE_REQUIRED on unprovable external state
```

Meaning of the important states:

- `PLANNED`: immutable paths and ownership reservations are durable, but no transfer has
  been accepted yet.
- `RECEIVING`: the peer may be sending data. The first implementation may discard and
  restart this state after process death because incoming chunk checkpoints are not yet
  durably wired.
- `SEALED`: every staging file and tree entry has been verified against the manifest;
  publication may begin.
- `PUBLISHING`: at least one root intent exists. Recovery inspects and rolls forward.
- `COMMITTED`: every root has a verified durable receipt. This is the only point at which
  the receiver may report publication success and make staging eligible for deletion.
- `CLEANUP_PENDING`: publication succeeded but owned staging or reservations remain.
- `DONE`: publication and owned cleanup completed.
- `RECONCILE_REQUIRED`: automatic action stopped because ownership or content cannot be
  proved.

`COMMITTED` and `DONE` never transition to failure or cancellation.

### Root transaction

```text
PLANNED
  -> READY
  -> INTENT_WRITTEN
  -> PUBLISHED
  -> VERIFIED

PLANNED | READY -> ABORTED, before any final-side effect
any nonterminal -> RECONCILE_REQUIRED on conflict or ambiguous ownership
```

- `READY` means the source tree is sealed and, for single-container or copy fallback, the
  hidden ready object is complete.
- `INTENT_WRITTEN` is persisted before a final-path side effect.
- `PUBLISHED` is a durable receipt for the backend side effect.
- `VERIFIED` additionally proves final type, exact tree membership, sizes, hashes, and
  ownership identity required by the backend.

For a backend whose publish operation and content verification are inseparable,
`PUBLISHED` and `VERIFIED` may be written in one compare-and-set update after inspection.
They remain distinct concepts in the model.

## Commit algorithm

1. Normalize the manifest and create the target plan with conflict-free top-level names.
2. Persist `PLANNED` before sending an accepted decision. If the journal cannot be made
   durable, reject the transfer and release only owned planner state.
3. Transition to `RECEIVING`. Write and verify data in the existing task staging tree.
4. After every file and directory matches the manifest, persist `SEALED`.
5. For each root in deterministic manifest order:
   1. prepare a ready object while retaining staging;
   2. persist root `READY`;
   3. persist `INTENT_WRITTEN` with its operation ID;
   4. execute the backend no-replace or owned-copy operation;
   5. inspect the destination independently;
   6. persist the content-bound receipt and `VERIFIED` by compare-and-set.
6. When all root receipts are verified, persist aggregate `COMMITTED`.
7. Report success to the stream/session owner only after step 6.
8. Remove owned staging, ready objects, and reservations. Persist `DONE`; on cleanup
   failure persist `CLEANUP_PENDING` and retry later.

An implementation may not remove the staging link immediately after a hard-link publish,
and may not consume the only directory staging tree with an unjournaled rename.

## Crash and cancellation semantics

| Crash or interruption point | Required recovery action |
| --- | --- |
| Before `PLANNED` is durable | The receiver has not accepted ownership. Clean only paths that can be proved to have been created by the failed planner invocation. |
| `PLANNED` before peer acceptance | Mark cancelled and clean owned staging/reservations. |
| During `RECEIVING` | Initial phase: mark interrupted and remove owned unsealed staging. Future incoming checkpoint persistence may resume it, but must be a separate capability. |
| After staging verification but before `SEALED` | Re-verify the entire staging plan; seal only on an exact match, otherwise retain for diagnosis or clean according to explicit policy. |
| `SEALED` before first root intent | Publication can restart from the first root; cancellation may still abort without visible output. |
| After `INTENT_WRITTEN`, before side effect | Inspect final. If absent, retry the same operation ID. If present, require ownership and content proof before adopting it. |
| After side effect, before receipt | Inspect final and ready/staging identities. Exact owned content becomes the missing receipt; absent content retries; anything else becomes `RECONCILE_REQUIRED`. |
| Between roots | Keep existing verified roots, continue remaining roots, and retain staging. Never compensate by deleting a published root. |
| After all root receipts, before `COMMITTED` | Re-verify receipts and persist `COMMITTED`. |
| After `COMMITTED`, before cleanup | Treat transfer as successful and retry only owned cleanup. |
| During cleanup | Re-run idempotent cleanup; do not change publication success. |

Cancellation before any final side effect can produce `CANCELLED`. Cancellation after a
root intent or side effect is recorded as `cancelRequested`, but the default safe policy
is to finish publication. Returning a partial/cancelled result is permitted only if the
backend truthfully retains already published roots and the UI exposes that partial state.

## Receipt idempotency and deduplication

Publication recovery will execute the same logical operation more than once. Duplicate
suppression therefore belongs in both the coordinator and backend.

- A root has exactly one deterministic `operationId`.
- The journal stores at most one receipt per root and enforces a unique
  `(publicationId, rootId)` key or equivalent JSON invariant.
- Persisting the byte-for-byte same receipt is a no-op.
- A second receipt with a different target token, identity, method, size, or tree hash is
  a conflict and transitions to `RECONCILE_REQUIRED`.
- State updates use the journal revision as compare-and-set; a losing writer reloads and
  revalidates rather than appending another receipt.
- Backend `inspect(operationId)` must not trust a journal receipt by itself. It checks the
  real target and returns `ABSENT`, `OWNED_MATCH`, `OWNED_INCOMPLETE`, or `CONFLICT`.
- A matching hash without ownership proof is insufficient when an external process could
  have created the path during the ambiguous crash window.

Useful ownership evidence includes:

- for hard-linked files, matching stable file identity between retained staging and final;
- an opaque provider token whose backend mapping is durably stored;
- a backend-owned hidden operation marker created exclusively and bound to the operation
  ID, removed only after aggregate commit;
- for native same-filesystem directory rename, a reliable pre/post object identity.

On filesystems or providers that cannot supply reliable identity, recovery must retain
the data and request reconciliation rather than deleting or adopting the target.

## Platform no-replace behavior

Portable Node APIs do not provide one uniform atomic no-replace rename for directories.
The backend must advertise capabilities and the coordinator must branch on them
explicitly.

| Backend or primitive | No-replace and atomicity boundary |
| --- | --- |
| Regular-file hard link | Creating the final link fails if the destination exists and is atomic for that directory entry. It requires the same filesystem and hard-link support. It preserves staging until commit. |
| `fs.copyFile(..., COPYFILE_EXCL)` | Refuses an existing destination, but a newly created final file may be visible while bytes are copied. Recovery needs ownership evidence and staging retention. It is not atomic visibility. |
| Node `fs.rename()` | Does not expose a no-replace flag. Check-then-rename is racy and must not be advertised as atomic no-overwrite publication. |
| Linux native backend | `renameat2(..., RENAME_NOREPLACE)` can supply the required operation when the kernel and filesystem support it. Cross-filesystem moves fail. |
| macOS native backend | `renameatx_np`/`renamex_np` with the exclusive flag can supply the operation where supported. |
| Windows native backend | A same-volume native move without replace semantics can be used, but it must be implemented and tested directly; Node `rename()` behavior is not the capability proof. Reparse points and case-insensitive collisions require revalidation. |
| Exclusively created final directory | `mkdir` can claim a root without replacing it. Populating that directory is recoverable and no-overwrite, but users may observe partial contents. A marker must identify ownership until commit. |
| Network/removable filesystems | Hard links, rename atomicity, identity values, directory sync, and write ordering vary. Capability probing plus fail-closed behavior is required; local filesystem results cannot be generalized. |
| Android MediaStore | There is no transaction spanning multiple rows. Pending objects can hide individual files, but making several rows visible is not an atomic batch. Persist and inspect each provider URI. |
| Android SAF | Rename, collision, durability, and identity are provider-specific. Treat returned document IDs as opaque tokens and retain truthful partial/reconcile states. |

The platform backend interface should report at least `supportsAtomicNoReplaceDirectory`,
`supportsHardLinks`, `supportsStableIdentity`, and `supportsDurableDirectorySync`.
Capability absence is part of the result, not an exception to the invariants.

## Migration and compatibility

### Journal schema

- Introduce schema version 1 and reject unknown future versions without filesystem side
  effects.
- All upgrades are explicit, deterministic, and covered by fixture tests.
- Corrupt or truncated records are quarantined. Recovery must not infer a safe final state
  from filenames alone.
- Atomic JSON replacement is not sufficient by itself when the platform cannot make the
  containing directory durable; that limitation must remain documented and tested as a
  backend capability.

### Existing Core and CLI state

- The publication-store argument must initially be additive and feature-gated so existing
  callers compile while hosts are migrated.
- Before the recovery feature is enabled by default, `createTransferReceiver()` must
  require a durable store rather than silently constructing one in an environment-derived
  directory.
- CLI stores publication records in its selected data directory and records the exact
  receive-root binding. Startup runs recovery before opening the listener.
- Existing orphan staging without a versioned journal is `LEGACY_UNVERIFIED`. It may be
  listed for manual cleanup, but must not be automatically published.
- Existing completed transfers are not imported into the new journal.
- The first CLI phase may restart interrupted `RECEIVING` transactions from zero. It must
  not advertise incoming byte-resume until writer progress and acknowledgements share a
  durable checkpoint.

### Desktop state

- The classic `TransferServer` remains unchanged and outside this claim.
- The SQLite v2 job store needs an explicit publication transaction/root table migration,
  or a separately owned publication database with a tested lifecycle. Merely exposing v2
  job IPC is not integration.
- Startup recovery must run before the v2 listener accepts incoming transfers and must
  share the same backend/store used by the live receiver.
- Old SQLite rows without publication metadata remain legacy rows. They are never inferred
  to be safely publishable.

### Wire and sender compatibility

- Manifest, chunk, progress, and completion wire formats remain unchanged for the first
  implementation.
- The receiver sends final success only after aggregate `COMMITTED` is durable.
- A sender retry using the same task and manifest may attach only to an exactly matching
  publication record; a different manifest under the same task ID is rejected.
- Classic peers and older v2 receivers continue their existing behavior. The new recovery
  guarantee applies only when the receiving implementation reports the capability and
  uses the durable path.

## Test matrix

All tests are local and deterministic. Fault injection must stop execution at an exact
journal or backend boundary rather than relying on timing.

### Core state-machine tests

| Case | Required assertion |
| --- | --- |
| Journal creation fails | Receiver does not accept; only owned planner paths are cleaned. |
| Duplicate plan | Exact plan is idempotent; different manifest/root mapping is rejected. |
| Revision race | Only one compare-and-set wins; the loser reloads without duplicating a receipt. |
| Duplicate receipt | Exact duplicate is a no-op. |
| Conflicting receipt | Transaction becomes `RECONCILE_REQUIRED`; staging is retained. |
| Cancellation before side effects | Final paths remain absent and owned staging is cleaned. |
| Cancellation after first root intent | Cancellation is durable and recovery follows the configured roll-forward/partial policy without deleting a published root. |
| Commit then cleanup failure | Result remains successful with `CLEANUP_PENDING`; retry reaches `DONE`. |
| Unknown/corrupt journal | No final-path mutation occurs. |

### Crash-window tests

Inject a restart after each of these points:

1. planner success, before `PLANNED`;
2. `PLANNED`, before acceptance;
3. last file sync, before `SEALED`;
4. `SEALED`, before the first root;
5. root `READY`;
6. root `INTENT_WRITTEN`;
7. backend side effect, before receipt;
8. receipt, before root `VERIFIED`;
9. between every pair of roots;
10. all roots verified, before `COMMITTED`;
11. `COMMITTED`, before staging cleanup;
12. each individual cleanup operation.

For each restart, assert the exact final tree, staging retention/removal, journal state,
receipt count, and absence of overwritten sentinel files.

### Filesystem and manifest matrix

- one regular file, including zero bytes;
- one top-level directory with nested empty directories;
- multiple top-level files;
- mixed top-level files and directories;
- Unicode, normalization-sensitive, long, and Windows case-colliding names;
- a destination appearing before intent, after intent, and during backend execution;
- symlink, junction/reparse-point, special-file, and receive-root replacement cases;
- hard-link supported, permission denied, cross-device, and unsupported cases;
- copy fallback interrupted at every write/sync boundary;
- user mutation of a published root before recovery;
- two processes attempting the same publication and two different tasks reserving the
  same logical root.

### Platform matrix

- Linux on a local filesystem: hard link and native no-replace directory backend if
  implemented;
- macOS on APFS: hard link and exclusive rename backend if implemented;
- Windows on NTFS: case-insensitive conflict handling, reparse-point rejection, native
  no-replace move, open-handle interference, and delayed cleanup;
- at least one hard-link-limited/removable filesystem, expected to select the documented
  fallback or fail closed;
- a network filesystem only as a capability-bound test, never as evidence for local
  atomicity;
- Android MediaStore and at least two SAF provider behaviors, retaining per-file partial
  state.

### Host integration tests

- CLI: start a receive, inject every crash window, restart with the same data and receive
  directories, run recovery before listen, and assert exactly one receipt per root.
- CLI shutdown: active receiver cleanup must not delete staging after `COMMITTED`.
- Desktop v2: database migration, app restart before listener startup, and shared
  coordinator/store ownership. These tests remain pending until the v2 receiver is wired.
- Desktop classic: regression tests prove the new v2 feature does not alter the current
  classic server.
- Android: retain existing intent/side-effect/receipt tests and add the aggregate
  commit-before-cleanup gate.

## Phased implementation checklist

### Phase 0: terminology and gates

- [ ] Keep public capability documents explicit that complete publication recovery is not
  implemented.
- [ ] Define backend capability names and user-visible partial/reconcile outcomes.
- [ ] Decide whether single-container layout is opt-in or deferred.

### Phase 1: Core model without behavior change

- [ ] Add validated publication plan, record, receipt, and store interfaces.
- [ ] Add the monotonic coordinator and deterministic operation IDs.
- [ ] Add an in-memory store and failpoint backend for exhaustive state-machine tests.
- [ ] Define storage/backend errors without changing the wire protocol.

### Phase 2: durable Core and CLI publication

- [ ] Add the file-backed CLI store with schema validation, atomic replacement, locking,
  quarantine, and recovery enumeration.
- [ ] Create `PLANNED` after target planning and before receiver acceptance.
- [ ] Transition to `SEALED` only after full staging verification.
- [ ] Replace `publishAllRoots()` with coordinator calls.
- [ ] Retain staging through aggregate `COMMITTED` and separate cleanup state.
- [ ] Run CLI recovery before opening the receive listener.
- [ ] Treat interrupted `RECEIVING` as restart-from-zero until incoming checkpoints are
  durably integrated.

### Phase 3: filesystem backends

- [ ] Implement and test hard-link publication for regular-file roots.
- [ ] Implement the owned-directory, persistent per-root fallback with truthful partial
  visibility.
- [ ] Decide whether to ship native Linux/macOS/Windows directory no-replace helpers.
- [ ] Gate single-container atomic publication on verified backend capabilities.
- [ ] Add platform-specific durability and no-replace tests.

### Phase 4: Desktop v2 integration

- [ ] Add the SQLite publication schema and migration tests.
- [ ] Compose the future desktop v2 incoming receiver with that store and backend.
- [ ] Run startup recovery before enabling the v2 listener.
- [ ] Keep classic transfer claims and behavior separate.

### Phase 5: incoming byte resume

- [ ] Persist receiver writer progress in the same transaction boundary as durable chunk
  acknowledgement.
- [ ] Restore staging only after path, size, hash, sequence, and file identity validation.
- [ ] Send a non-zero resume checkpoint only from committed receiver state.
- [ ] Test restart during every chunk/file boundary independently of publication recovery.

### Phase 6: claim gate

Public documentation may claim restart-safe publication recovery only after all of the
following are true:

- [ ] Core uses the durable coordinator on the default v2 receive path.
- [ ] CLI startup recovery is enabled by default and passes its crash matrix.
- [ ] Desktop claims are limited to a genuinely wired and tested v2 receiver.
- [ ] Staging is retained through aggregate commit on every supported backend.
- [ ] Receipt deduplication and reconcile behavior pass concurrent-process tests.
- [ ] Platform no-replace behavior is verified on every advertised filesystem/backend.
- [ ] Partial visibility and unsupported atomic-container cases are documented truthfully.
- [ ] Migration, corruption, cancellation, cleanup, and power-loss windows have automated
  coverage.

Until this gate is satisfied, the accurate statement is: verified staging and selected
publication paths have focused lifecycle tests, but complete crash recovery and atomic
multi-root publication are not implemented end to end.

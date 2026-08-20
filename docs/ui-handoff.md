# Android UI handoff

This document is for the next UI-focused agent. It describes the current UI
boundary and the expected direction for the v1.0 redesign. The Android app is
an operational file-transfer tool, so the UI should prioritize scanning,
clear state, and reliable actions over decorative content.

## Current entry points

### Production app

`MainActivity` is still the only production launcher. It builds the current
screen programmatically with legacy Android Views. Do not replace its runtime
behavior while protocol, persistence, and receive-runtime work is still in
progress.

The production shell currently exposes three sections:

- **Transfer**: choose a file, refresh nearby legacy peers, select a peer, send,
  and inspect the current transfer progress.
- **Devices**: refresh v2 discovery, start/cancel/confirm pairing, save or revoke
  trusted peers, and inspect pending pairing actions.
- **Settings**: expand local identity/save-directory details and inspect logs.

The relevant implementation is
`android-app/src/main/java/io/github/nearbytransfer/android/MainActivity.java`.
The Activity is a composition root only. Private keys, session keys, protocol
state, Room repositories, and transfer runtime objects must stay outside UI
state and View callbacks.

### Compose migration preview

`ComposeMigrationActivity` and `NearbyTransferMigrationApp` are a debug-only
visual shell. They are not production navigation and have no discovery,
pairing, transfer, persistence, or real action handlers. The preview's bottom
navigation currently contains placeholder destinations and inert `onClick`
callbacks. Keep it clearly marked as a preview, or implement navigation before
showing it to users; never make it the launcher by accident.

Related files:

- `android-app/src/main/kotlin/io/github/nearbytransfer/android/migration/ComposeMigrationActivity.kt`
- `android-app/src/main/kotlin/io/github/nearbytransfer/android/feature/home/NearbyTransferMigrationApp.kt`
- `docs/android-compose-migration.md`

## Work already completed

The current production UI already includes the first cleanup pass:

- Large unrelated launcher regions were reduced into three focused sections.
- Navigation is compact and keeps only one section visible at a time.
- Device rows are selectable and expose a selected state.
- Pairing actions are explicit: start, confirm matching code, save trust, and
  cancel.
- Local save settings are collapsed by default and expand on demand.
- Transfer progress is hidden until a transfer event exists, then shows status,
  bytes, percentage, and rate/detail.
- The diagnostics log is a bounded, fixed-height viewport. It is currently
  `168dp` high and retains at most 80 entries through `BoundedLogBuffer`.
  It follows new entries only while the user is already near the bottom; manual
  scrolling must not be interrupted.

These behaviors are part of the current baseline. A UI rewrite should preserve
them or provide an explicit test and replacement behavior before changing them.

## Problems still worth solving

### 1. Make the UI state-driven

The Java Activity currently creates many Views and updates them directly from
network, pairing, permission, and transfer callbacks. The next UI batch should
introduce a small immutable screen-state model and render from it. At minimum,
model these independent states:

- permission missing, starting, ready, and startup failure;
- no nearby peers, scanning, peer available, peer selected, and peer lost;
- no trusted peers and trusted peer revoked;
- pairing pending, local confirmation required, remote confirmation required,
  ready to trust, completed, cancelled, and expired;
- file not selected, file selected, transfer waiting for approval, active,
  completed, rejected, failed, and disconnected;
- empty log, log available, and log manually scrolled away from the tail.

Do not infer state from button text or from whether a container happens to be
visible. Use one source of truth and make impossible actions disabled or absent.

### 2. Remove inactive visual weight

On a phone, every visible block should answer one of these questions: what is
the current state, what can I do next, or what result needs my attention.
Remove placeholder panels, duplicated status text, oversized empty areas, and
labels that look interactive but are not clickable. Empty states should be
compact and explain the next useful action. A disabled primary action should
state the missing prerequisite nearby, rather than consuming a large panel.

Keep cards shallow and consistent. Do not nest cards inside cards or add a
marketing-style hero. The first viewport should show the current status and
the primary transfer action without forcing the user through decorative space.

### 3. Make actions and priority unambiguous

There should be one obvious primary action per state. Examples:

- file selected but no peer: show peer discovery/selection as the next step;
- peer selected but no file: show file selection as the next step;
- pending pairing: surface the Devices action and its urgency;
- transfer failed: show a useful retry path and preserve the failure reason;
- trusted peer revoked: do not offer a transfer action until trust is restored.

Use familiar icons where they add meaning, with accessible text or content
descriptions for unfamiliar actions. Every button, clickable row, and tab must
have a real handler, a disabled state with a reason, or be removed. Do not add
fake pause/resume/retry controls until the runtime supports them.

### 4. Preserve the fixed log viewport

The log is diagnostics, not the main workflow. Keep it in a bounded viewport so
new messages cannot push the rest of the Settings screen downward indefinitely.
The current contract is:

- fixed viewport height, currently `168dp`;
- vertical scrolling inside the viewport;
- selectable text;
- bounded history, currently 80 entries;
- auto-follow only when the user is at the bottom;
- if the user scrolls upward, new entries update the content without jumping;
- when the Settings section is opened while following the tail, show the latest
  entries.

If the UI agent changes the height or presentation, test small phones,
landscape, font scaling, long exception messages, and a burst of log events.
Prefer a compact “clear/copy” action only if the backing behavior is implemented
and covered by a focused test.

## Accessibility and responsive requirements

- Preserve at least a 48dp touch target for buttons, tabs, and selectable rows.
- Add content descriptions for icon-only actions and meaningful state changes.
- Keep TalkBack order aligned with the visual action order.
- Support font scale 1.0 and 1.3 without clipping or overlapping text.
- Test widths around 320dp, 360dp, and 411dp, plus landscape orientation.
- Long device names, file names, fingerprints, paths, and error messages must
  wrap or ellipsize within their parent; they must not resize neighboring
  controls or create horizontal scrolling.
- Do not rely on color alone for selected, pending, failed, or completed state.
- Move user-facing strings into both `values/strings.xml` and
  `values-zh-rCN/strings.xml` as the Compose migration progresses. Existing Java
  strings can be migrated incrementally, but new UI strings should not be
  hard-coded.

## Recommended implementation order

1. Capture the current production screen and inventory every visible control,
   callback, and state transition.
2. Define UI state and events without changing the protocol or persistence
   contracts.
3. Extract reusable screen primitives: status banner, compact empty state,
   peer row, pairing row, transfer progress, and bounded log.
4. Reduce vertical spacing and remove non-actionable blocks on the Transfer and
   Devices sections first.
5. Move strings, dimensions, colors, and accessibility labels to resources.
6. Add Compose parity behind the existing debug-only flag. Keep the Java shell
   as the production fallback until feature parity and runtime tests are proven.
7. Run screenshot/manual checks for all state combinations before changing the
   launcher or deleting the legacy screen.

Keep UI-only commits separate from protocol, crypto, Room, and transfer-runtime
commits. This makes visual review and rollback practical.

## UI acceptance matrix

Before promoting a UI batch, verify the following on an unlocked Android device
and with a small emulator/profile:

| Area | Required checks |
| --- | --- |
| Startup | Permission request, denied permission, startup failure, ready state |
| Transfer | No file, file selected, no peer, peer selected, peer disappears |
| Pairing | Pending confirmation, matching code, wrong/cancelled/expired flow, saved trust |
| Progress | Preparing, waiting, active, completed, rejected, failed, disconnect |
| Settings | Collapsed details, custom directory, default directory, long path |
| Logs | Empty, burst of entries, bounded history, manual scroll, return to tail |
| Layout | 320/360/411dp, landscape, font scale 1.3, long names and errors |
| Accessibility | TalkBack order, labels, touch targets, non-color-only states |

The minimum regression commands are documented in
`docs/next-version-handoff.md` and `AGENTS.md`:

```powershell
npm run check
npm test
.\gradlew.bat :android-app:testDebugUnitTest :android-app:assembleDebug --no-daemon
```

For screenshots, install the generated debug APK manually and record the device
model, Android version, orientation, font scale, and tested state. Do not commit
APK files, Gradle caches, screenshots, or machine-specific paths.

## Do not cross this boundary accidentally

- Do not enable the v2 production transfer route just to make a UI button look
  complete. The receive runtime and publication flow are still being integrated.
- Do not put private identity material, session keys, or Room handles in a
  composable, View, Activity field, saved instance state, or log message.
- Do not change protocol messages, trust semantics, or checkpoint formats in a
  UI-only change.
- Do not leave inert navigation or placeholder actions in a screen presented as
  production.

Start from `next/1.0`, read `AGENTS.md`, then use this document together with
`docs/next-version-handoff.md` and `docs/android-compose-migration.md`.

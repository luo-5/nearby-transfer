# Android Room trusted-peer foundation

The v2 Android migration now has a Room-backed `TrustedPeerRepository` implementation.

## Stored data

`NearbyTransferDatabase` contains a single `trusted_peers` table. Each row contains only public, durable peer metadata:

- protocol device ID;
- display name;
- public-key fingerprint;
- granted `TRANSFER`, `LIBRARY_READ`, and `LIBRARY_UPLOAD` permissions;
- `TRUSTED` or `REVOKED` status;
- pairing and update timestamps.

It must **never** contain identity private keys, pairing codes, nonces, session keys, transfer encryption keys, or other transient secrets. Pairing and transport code will keep those values in memory only.

## Permission format and revocation

Permissions are encoded as canonical, lexicographically sorted enum names separated by commas. Invalid, duplicated, unknown, or non-canonical encodings are rejected rather than interpreted permissively.

Revoking a peer clears all persisted permissions. A revoked row cannot be switched back to trusted, and an upsert cannot restore its grants. To trust the device again, delete the revoked record only after a new verified pairing completes.

## Integration boundary

UI and feature code use `TrustedPeerRepository`, not Room DAOs. Create the database in the Android application composition root and inject `RoomTrustedPeerRepository(database.trustedPeerDao())` when the Compose migration becomes the production UI.

Validate the foundation with:

```powershell
.\gradlew.bat :android-app:testDebugUnitTest :android-app:assembleDebug --no-daemon
```
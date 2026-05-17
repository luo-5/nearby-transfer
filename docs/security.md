# Security Model

## Goals

- Keep file content encrypted on the local network.
- Require explicit user approval for every incoming transfer.
- Avoid a central server or account system.

## Current MVP

- Every device creates a persistent Ed25519 identity key and X25519 encryption key.
- The displayed fingerprint is derived from the Ed25519 identity public key.
- Transfer requests are signed with the sender's Ed25519 identity key.
- Receivers verify that the advertised fingerprint matches the signed identity public key.
- Each transfer uses a fresh sender ephemeral X25519 key.
- File content is encrypted in independent AES-256-GCM chunks.
- The receiver verifies the final plaintext SHA-256 hash before saving the file.

## Limitations

- Discovery messages are not encrypted.
- The current MVP does not implement long-term pairing or trusted devices because every transfer must be manually accepted.
- A user should compare fingerprints if they need strong protection against local-network impersonation.

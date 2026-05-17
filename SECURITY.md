# Security Policy

## Supported Versions

The project is currently pre-1.0. Security fixes are made on the default branch until stable release branches exist.

## Reporting Vulnerabilities

Please report security issues privately by opening a GitHub security advisory when the repository is published. If advisories are unavailable, open a minimal public issue that requests maintainer contact without disclosing exploit details.

## Current Security Model

- File contents are encrypted before they enter the local-network HTTP upload body.
- Transfer requests are signed with persistent device identity keys.
- Every incoming file requires manual user confirmation.
- Discovery packets and transfer metadata are visible on the LAN in the current MVP.

See `docs/security.md` for the detailed model and limitations.

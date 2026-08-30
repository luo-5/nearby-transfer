# Security policy

## Supported versions

Nearby Transfer has several independently versioned surfaces. Security fixes normally
land on the default branch first; a source fix is not present in an older binary until a
new artifact containing that commit is published.

| Version line | Support status |
| --- | --- |
| Default branch | Active development; review the exact commit and its checks before building. |
| Desktop `v1.3.0` | Current public desktop release. It predates later default-branch changes, so consult the changelog and commit history before relying on a specific fix. |
| Latest npm package tags | Active pre-1.0 development; APIs and security boundaries can change between releases. |
| Older application and package versions | Upgrade before reporting an issue that may already be fixed. |

There is not yet a long-term-support branch or an independently audited stable release
line.

## Reporting vulnerabilities

Please use GitHub's private vulnerability-reporting flow from the repository's
**Security** tab when it is available. Include the affected version or commit, the
affected client/path, reproduction steps, impact, and any suggested mitigation.

If private reporting is unavailable, open a minimal public issue requesting maintainer
contact. Do not include exploit details, secrets, personal data, or a working
proof-of-concept in the public issue.

Please allow the maintainer reasonable time to reproduce, coordinate a fix, and prepare
an affected release before public disclosure.

## Current security boundaries

- The current desktop direct-transfer path encrypts file contents before they enter the
  local-network HTTP upload stream and verifies the final size and SHA-256 digest.
- Transfer requests are signed, but the public key used for verification is carried in
  the request. This is not the same as binding the sender to a previously verified
  protocol-v2 SAS identity; receiver confirmation remains important.
- UDP discovery packets and transfer metadata are visible to other devices on the LAN.
- The HTTPS/WebDAV shared-folder service has a separate authorization model and uses a
  self-signed certificate. Clients must verify or pin that certificate, and the service
  must not be exposed directly to the public internet.
- Protocol-v2 components implement stronger identity, pairing, authenticated-chunk,
  replay, and framing mechanisms, but those guarantees apply only where the complete v2
  path is integrated correctly.
- No independent security audit is currently documented.

See [`docs/capabilities.md`](docs/capabilities.md) for path-by-path maturity and
[`docs/security.md`](docs/security.md) for the protocol-v2 architecture and threat
model. The latter describes the v2 design, not a blanket guarantee for every client or
transport path.

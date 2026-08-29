# Security policy

## Supported versions

| Version | Security support |
| --- | --- |
| `main` | Active development and security fixes |
| `1.3.x` | Best-effort fixes for reproducible vulnerabilities affecting shipped assets |
| `< 1.3` | Not supported; upgrade or build a fixed revision from source |
| npm packages `< 1.0` | Active development; upgrade to the newest compatible package release |

The application and npm packages use separate version lines. A version being listed
here does not mean every experimental protocol or platform is supported. See the
[capability and security matrix](docs/capabilities.md).

## Reporting a vulnerability

Please use **Report a vulnerability** on the repository Security tab to open a
private GitHub security advisory. Do not include exploit details, secrets, personal
data, or third-party files in a public issue.

If private reporting is unavailable, open a minimal public issue asking a maintainer
to establish private contact. Include only the affected component and a way to reach
you; do not describe the exploit publicly.

Helpful private reports include:

- affected commit, release, client, package, and protocol path;
- reproduction prerequisites and the smallest safe proof of concept;
- expected and observed behavior;
- realistic impact and attacker assumptions;
- suggested mitigation, if known.

Maintainers aim to acknowledge a complete report within seven days and provide an
initial assessment within fourteen days. These are targets for a small volunteer
project, not guaranteed service-level agreements. Disclosure timing will be agreed
with the reporter after a fix and release plan exist.

## Scope

In scope:

- identity, pairing, authorization, replay, or cryptographic boundary failures;
- path traversal, symlink/reparse-point escape, unintended overwrite, or unsafe
  publication of received files;
- remotely triggerable resource exhaustion that bypasses documented limits;
- WebDAV authentication, permission, TLS/pinning, or share-root escapes;
- release-workflow, artifact-integrity, or package-supply-chain vulnerabilities.

Generally out of scope unless they cross a documented security boundary:

- denial of service requiring local control of the same user account;
- attacks that require replacing an already trusted binary or private key;
- vulnerabilities only in unsupported versions;
- missing confidentiality in LocalSend HTTP interoperability, which is explicitly
  documented as a protocol limitation.

## Current security model

- The classic desktop transfer path encrypts file contents and signs transfer
  requests, but discovery and transfer metadata remain visible on the LAN.
- Protocol-v2 components implement signed identities, SAS derivation, authenticated
  chunks, bounded frames, and replay-aware controls. The complete v2 data path is not
  yet the default desktop transfer implementation.
- The WebDAV library uses a separate HTTPS and permission model; it is not v2
  end-to-end file transfer.
- The LocalSend adapter follows the LocalSend HTTP interoperability boundary and must
  not be described as inheriting Nearby Transfer v2 confidentiality.
- Incoming filenames, identifiers, sizes, and persisted records are treated as
  untrusted input and must remain confined to validated staging and receive roots.

The detailed threat model is in [`docs/security.md`](docs/security.md).

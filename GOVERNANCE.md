# Governance

Nearby Transfer uses a maintainer-led model while the contributor community is small.

## Decisions

- Routine fixes and documentation changes are decided through pull-request review.
- Protocol, persistence, compatibility, security-boundary, and release-process
  changes require an explicit maintainer decision recorded in the PR.
- Significant behavior changes should include an issue or design note describing
  alternatives, compatibility impact, and migration strategy.
- When consensus is not reached, the repository owner makes the final decision and
  records the reasoning publicly unless doing so would disclose an embargoed issue.

## Pull requests

- Authors do not merge while required checks are failing.
- Reviews must evaluate tests and documentation as well as implementation.
- Security-sensitive code should receive a second human review when another qualified
  reviewer is available. A small-team exception must be documented in the PR.
- Maintainers may close inactive or out-of-scope proposals with an explanation and a
  path to reopen when the blocking condition changes.

## Security

Vulnerabilities follow [`SECURITY.md`](SECURITY.md). Embargoed reports and release
credentials are limited to maintainers who need access. Public disclosure occurs after
a mitigation and release plan exist.

## Releases

Only maintainers may create release tags or publish packages. Namespaced immutable
tags, version checks, provenance, artifact checksums, documented signing status, and
the process in [`docs/releasing.md`](docs/releasing.md) are required.

## Governance changes

Governance changes use normal pull requests and should remain open long enough for
active contributors to comment. Maintainer appointments and removals are reflected in
[`MAINTAINERS.md`](MAINTAINERS.md) and `.github/CODEOWNERS`.

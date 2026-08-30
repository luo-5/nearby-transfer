# Cross-machine test plan (future manual gate)

This is a planning document, not a currently executable automated procedure. The project's CLI does not yet provide a first-use pairing flow that completes and persists mutual trust, so a fresh pair of machines cannot run the full CLI transfer scenario without separately provisioned trust state.

No test in this document requires changing a host's VPN, routing table, network adapter, DNS, proxy, or firewall configuration. If two test machines cannot already communicate on an isolated test network, stop the test and record the environment as unsupported rather than changing host networking.

## Preconditions

- Use disposable test data and dedicated test devices.
- Install the same source revision or release on both endpoints.
- Confirm both endpoints use signed classic discovery announcement version 2.
- For CLI testing, provision trusted-peer state through a documented supported flow; the current `pair` preview does not do this.
- Do not run this plan while either endpoint is being used for unrelated transfers.

## Planned compatibility matrix

- Windows to Windows
- Windows to a supported Linux distribution
- Linux to Linux
- Desktop to Android for the classic path

## Manual observations

For each pair, record:

1. whether both endpoints display the expected peer identity and fingerprint;
2. whether the receiving user sees the expected file name and size before approval;
3. whether accept and reject paths both finish cleanly;
4. whether cancellation leaves no published partial file;
5. whether an existing destination is preserved; and
6. whether source and received SHA-256 digests match after completion.

The current CLI send syntax uses the source path as a positional argument:

```text
nearby-transfer send <source-path> --to <trusted-device-id>
```

Do not expect the current CLI to provide a complete first-use trust bootstrap or a fully documented interactive progress UI. Those are separate product gaps.

## Evidence template

Store only non-sensitive evidence:

- source revision and package versions;
- operating-system family and architecture;
- pass/fail for each observation above;
- sanitized error messages; and
- file sizes and SHA-256 values for generated test fixtures.

Do not commit local account names, machine addresses, credentials, device serial numbers, or absolute personal paths.

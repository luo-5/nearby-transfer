# @luo-5/protocol-spec

The Nearby Transfer v2 protocol specification and deterministic test vectors.

This is a **documentation-only** package (not published to npm). It contains:

- `v2-spec.md` — the complete protocol specification (11 chapters + appendices).
- Test vectors are maintained in `packages/core/test/vectors/` alongside the
  reference implementation so the vectors can be regenerated and verified by the
  core test suite.

## Reading the spec

Start at `v2-spec.md`. The spec is the normative reference for the v2 wire format,
cryptographic primitives, and message flows. The reference implementation lives in
[`@luo-5/core`](../core) and its test suite enforces the test vectors.

## Regenerating vectors

```bash
cd packages/core
npx tsx scripts/generate-all-vectors.ts
```

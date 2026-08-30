# Skipped / Pending Tasks

## npm 0.2.0 publish — RESOLVED ✅
- Date: 2026-08-28
- Status: `@luo-5/core@0.2.0` and `@luo-5/cli@0.2.0` published successfully to npm registry.
- Verification: `npm view @luo-5/core@0.2.0 version` -> `0.2.0`, `npm view @luo-5/cli@0.2.0 version` -> `0.2.0`.
- Git release tag: `v0.2.0` created and pushed to `origin`.

## Docker build — RESOLVED ✅
- Date: 2026-08-26
- Status: Historical Docker image build reported on a CentOS test host (address removed).
- Docker CE 29.7.2 installed on CentOS via yum.
- Image: `nearby-transfer-cli:latest`
- Build fix: Added `RUN cd packages/core && npm install --save-dev @types/node@24` to Dockerfile (DTS build needed @types/node).
- `.dockerignore` created to exclude node_modules, dist, .git, android-app, release_artifacts.
- Verification: `docker run --rm nearby-transfer-cli --help` outputs CLI usage correctly.

## Cross-machine transfer tests — RESOLVED ✅
- Date: 2026-08-26
- Status: 3/3 pairs passed with SHA-256 verification.
- Ubuntu → CentOS: PASS ✅
- Windows → Ubuntu: PASS ✅ (Windows as sender due to NAT inbound restriction)
- Windows → CentOS: PASS ✅
- Note: Windows VM uses VMware NAT, inbound TCP ports unreachable from other VMs. Windows acts as sender (outbound) for all pairs involving it.

## Strangler Fig batch 3 — RESOLVED ✅
- All 25 v2 JS modules migrated to TypeScript `@luo-5/core` or adapted as thin IPC wrappers.
- Batch 3a (7 pure logic), 3b (10 fs/net/scheduler), 3c (8 Electron/IPC adapters) — 100% complete and passing all 41 test suites.

## Gemini Performance Benchmarks — RESOLVED ✅
- AES-256-GCM chunk throughput: ~688 MB/s encrypt, ~744 MB/s decrypt.
- Local TCP Loopback streaming transfer: ~250 MB/s end-to-end throughput.
- Canonical JSON serialization benchmarked across standard and optimized implementations.

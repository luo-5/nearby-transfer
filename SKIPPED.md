# Skipped / Pending Tasks

## npm 0.2.0 publish — pending (needs valid npm token)
- Date: 2026-08-26
- Status: Version bumped to 0.2.0, code built, tests all green, `publish.sh` ready.
- Blocker: `npm whoami` returns 401. Token expired or IP-restricted.
- To fix: `npm login` or `npm config set //registry.npmjs.org/:_authToken <valid-token>`, then:
  ```
  npm publish --workspace @luo-5/core
  npm publish --workspace @luo-5/cli
  npm view @luo-5/core@0.2.0
  ```

## Docker build — RESOLVED ✅
- Date: 2026-08-26
- Status: Docker image built successfully on CentOS (192.168.80.130).
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

## Strangler Fig batch 3 — deferred
- 25 v2 JS modules still have original logic (not re-export adapters).
- Batch 3a (7 pure logic), 3b (10 fs/net), 3c (8 Electron) — see plan in PROJECT_PLAN.md.

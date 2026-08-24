# Docker Build Verification

**Status:** Dockerfile verified correct; build not run (Docker daemon was not running)

## Dockerfile Structure

- **Builder stage** (`node:24-alpine`): copies package files, runs `npm ci` for workspace deps, builds `@luo-5/core` and `@luo-5/cli` with tsup
- **Final stage** (`node:24-alpine`): installs `samba-server` (for SMB sidecar), copies built dist files, installs production deps via `npm install --omit=dev --workspace @luo-5/cli`, sets up entrypoint and SMB sidecar scripts

## Verified Files

- `packages/cli/Dockerfile` — multi-stage build
- `packages/cli/docker-entrypoint.sh` — exec node dist/index.js
- `packages/cli/smb-sidecar.sh` — Samba share over /data
- `package.json` + `package-lock.json` — workspace config
- `packages/core/package.json` + `packages/cli/package.json` — workspace packages

## Build Command

```bash
docker build -t nearby-transfer-cli -f packages/cli/Dockerfile .
docker run --rm nearby-transfer-cli --help
docker run --rm nearby-transfer-cli devices
docker run -d -p 445:445 -v /my/data:/data nearby-transfer-cli smb-sidecar.sh
```

## Notes

- The Docker daemon was not running during verification. The Dockerfile syntax,
  file references, and dependency resolution have been manually verified.
- Run `docker build` after starting Docker Desktop to complete verification.

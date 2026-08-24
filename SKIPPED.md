# Skipped Tasks

## P2: npm publish — npm auth 401
- Date: 2026-08-25
- Reason: `npm whoami` returns 401 Unauthorized. The token in `~/.npmrc` is either expired or IP-restricted. Cannot publish from this machine.
- Version bumps applied (0.1.0 → 0.2.0) and committed, but actual `npm publish` deferred to when a valid token is available.
- To fix: run `npm login` or set a valid `npm config set //registry.npmjs.org/:_authToken <token>` from an authorized IP, then:
  ```
  npm publish --workspace @luo-5/core
  npm publish --workspace @luo-5/cli
  npm view @luo-5/core@0.2.0
  ```

## P2: Docker build — daemon not running
- Date: 2026-08-25
- Reason: Docker Desktop is installed (v29.7.2) but the daemon is not running.
- Dockerfile verified correct in previous session.
- To fix: start Docker Desktop, then:
  ```
  docker build -t nearby-transfer-cli -f packages/cli/Dockerfile .
  docker run --rm nearby-transfer-cli --help
  ```

## P1: git push — GitHub unreachable
- Date: 2026-08-25
- Reason: `git push origin main` failed with "Failed to connect to github.com:443" (3 retries, 15s intervals).
- Commits are local. To fix: retry `git push origin main` when GitHub is reachable.

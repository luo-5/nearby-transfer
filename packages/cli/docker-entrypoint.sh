#!/bin/sh
set -e

# docker-entrypoint.sh — entry point for the Nearby Transfer CLI Docker image.
# Supports: docker run -v /host/dir:/data nearby-transfer send /data/file.txt --to <ip>

case "${1:-}" in
  smb-sidecar|smb-sidecar.sh)
    shift
    exec /usr/local/bin/smb-sidecar.sh "$@"
    ;;
esac

exec node /app/packages/cli/dist/index.js "$@"

#!/bin/sh
set -e

# docker-entrypoint.sh — entry point for the Nearby Transfer CLI Docker image.
# Supports: docker run -v /host/dir:/data nearby-transfer send /data/file.txt --to <ip>

exec node /app/packages/cli/dist/index.js "$@"

#!/bin/bash
# Nearby Transfer - Linux WebDAV NAS Mount Script
set -e

MOUNT_POINT="${1:-/mnt/nearby-transfer}"
SERVER_URL="${2:-http://192.168.9.151:56578/webdav/default-share}"

echo "================================================="
echo ">>> MOUNTING NEARBY TRANSFER NAS ON LINUX <<<"
echo "================================================="
echo "Mount Point: $MOUNT_POINT"
echo "Server URL : $SERVER_URL"

mkdir -p "$MOUNT_POINT"

if command -v mount.davfs >/dev/null 2>&1; then
    echo "Using davfs2..."
    sudo mount -t davfs "$SERVER_URL" "$MOUNT_POINT" -o noauth
    echo ">>> Mounted successfully at $MOUNT_POINT <<<"
elif command -v gio >/dev/null 2>&1; then
    echo "Using GIO / GVfs..."
    gio mount "dav://${SERVER_URL#http://}"
    echo ">>> Mounted in user file manager via GVfs <<<"
else
    echo "Please install davfs2 (e.g. sudo apt install davfs2) or access via file manager address: $SERVER_URL"
fi

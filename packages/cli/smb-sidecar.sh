#!/bin/sh
# SMB sidecar for the Nearby Transfer CLI Docker image.
#
# Configures and starts smbd to share the /data directory over SMB, so Windows
# clients can mount \\<container-ip>\nearby and macOS/Linux clients can mount
# smb://<container-ip>/nearby without installing any additional software.
#
# Usage (inside the container):
#   /usr/local/bin/smb-sidecar.sh
#
# Or from the host:
#   docker run -d -p 445:445 -v /my/data:/data <image> smb-sidecar.sh
#
# SMB service is only available in Linux/Docker environments. The Windows and
# macOS desktop apps do not include an SMB server.

set -eu

SHARE_DIR="${SHARE_DIR:-/data}"
SHARE_NAME="${SHARE_NAME:-nearby}"
SMB_USER="${SMB_USER:-nt}"
SMB_PASS="${SMB_PASS:-nearby}"

# Ensure the share directory exists
mkdir -p "$SHARE_DIR"

# Create a dedicated Samba config (does not touch the system default)
SMB_CONF="/tmp/smb-sidecar.conf"
cat > "$SMB_CONF" <<EOF
[global]
  workgroup = WORKGROUP
  server role = standalone
  security = user
  map to guest = Bad User
  guest account = nobody
  log level = 1
  bind interfaces only = no

[$SHARE_NAME]
  path = $SHARE_DIR
  browseable = yes
  writable = yes
  guest ok = yes
  force user = root
  create mask = 0644
  directory mask = 0755
EOF

# Add a guest-accessible user so smbd starts cleanly
if ! id "$SMB_USER" 2>/dev/null; then
  adduser -D -H "$SMB_USER" 2>/dev/null || true
fi

# Start smbd in the foreground (-F) with our config
echo "[smb-sidecar] sharing $SHARE_DIR as smb://<container-ip>/$SHARE_NAME"
echo "[smb-sidecar] Windows mount: \\\\<container-ip>\\$SHARE_NAME"
exec smbd -F -S -s "$SMB_CONF"

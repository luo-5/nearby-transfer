#!/usr/bin/env python3
"""
scripts/test_rclone_webdav_interop.py
Autonomous rclone and WebDAV RFC 4918 deep interop test suite.
"""

import os
import sys
import time
import json
import shutil
import hashlib
import subprocess
import paramiko
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

WORKSPACE = Path(__file__).resolve().parent.parent
SCRATCH = WORKSPACE / "scratch" / "rclone_test"
HOST_IP = "192.168.80.1"
UBUNTU_IP = "192.168.80.128"
VM_USER = os.getenv("VM_USER", "l")
VM_PASS = os.getenv("VM_PASS", "123")
PORT = 56588

def compute_sha256(filepath):
    h = hashlib.sha256()
    with open(filepath, "rb") as f:
        while chunk := f.read(65536):
            h.update(chunk)
    return h.hexdigest()

def main():
    print("=" * 60)
    print("   WEBDAV & RCLONE DEEP INTEROPERABILITY TEST SUITE   ")
    print("=" * 60)

    if SCRATCH.exists():
        shutil.rmtree(SCRATCH)
    SCRATCH.mkdir(parents=True, exist_ok=True)

    share_dir = SCRATCH / "server_share"
    share_dir.mkdir(parents=True, exist_ok=True)
    client_src = SCRATCH / "client_src"
    client_src.mkdir(parents=True, exist_ok=True)

    # 1. Generate test data files
    print("[1/6] Generating test dataset (files, nested folders, unicode, large 30MB stream)...")
    dataset_hashes = {}

    # Small & medium files
    for i in range(1, 31):
        rel_path = f"file_{i:03d}.txt" if i <= 15 else f"sub_{i%3}/nested_{i:03d}.dat"
        full_path = client_src / rel_path
        full_path.parent.mkdir(parents=True, exist_ok=True)
        content = f"Test file content number {i}\n".encode() * (i * 200)
        full_path.write_bytes(content)
        dataset_hashes[rel_path] = hashlib.sha256(content).hexdigest()

    # Unicode & Chinese filenames
    unicode_files = [
        ("中文测试文档_财务报表.txt", "这是包含中文字符的报表数据\n" * 50),
        ("sub_unicode/图片与视频清单 📸.log", "Emoji and CJK test content 🚀\n" * 40),
        ("special_chars_!@#$^&()_+.json", json.dumps({"test": "special characters", "ok": True}))
    ]
    for rel_path, text in unicode_files:
        full_path = client_src / rel_path
        full_path.parent.mkdir(parents=True, exist_ok=True)
        content = text.encode("utf-8")
        full_path.write_bytes(content)
        dataset_hashes[rel_path] = hashlib.sha256(content).hexdigest()

    # 30MB Large binary file
    large_name = "large_payload_30mb.bin"
    large_path = client_src / large_name
    print(f"Generating 30MB binary payload at {large_path}...")
    with open(large_path, "wb") as f:
        for _ in range(30):
            f.write(os.urandom(1024 * 1024))
    dataset_hashes[large_name] = compute_sha256(large_path)

    print(f"Generated {len(dataset_hashes)} test items, total size: {sum(p.stat().st_size for p in client_src.rglob('*') if p.is_file()) / (1024*1024):.2f} MB")

    # 2. Start WebDAV HTTPS server in Node.js
    server_script = SCRATCH / "start_webdav_server.js"
    server_script.write_text(f"""
const path = require('path');
const fs = require('fs');
const {{ DesktopLibraryService }} = require('{str(WORKSPACE / "src" / "v2" / "desktop-library-service.js").replace('\\', '/')}');

class MockTrustedPeerStore {{
  constructor(peers = {{}}) {{ this.peers = new Map(Object.entries(peers)); }}
  getPeer(deviceId) {{ return this.peers.get(deviceId) || null; }}
}}

const shareDir = '{str(share_dir).replace('\\', '/')}';
const peerStore = new MockTrustedPeerStore({{
  'ubuntu-rclone-peer': {{
    deviceId: 'ubuntu-rclone-peer',
    isTrusted: () => true,
    permissions: {{ libraryRead: true, libraryUpload: true, transfer: true }}
  }}
}});

const service = new DesktopLibraryService({{
  trustedPeerStore: peerStore,
  shares: [
    {{ id: 'test-share', name: 'Test Share', localPath: shareDir, readOnly: false }}
  ]
}});

async function start() {{
  const port = await service.start({PORT});
  const token = service.createSessionToken('ubuntu-rclone-peer', 3600 * 1000);
  console.log('WEBDAV_SERVER_READY:' + JSON.stringify({{ port, token }}));
}}

start().catch(err => {{
  console.error('Server start error:', err);
  process.exit(1);
}});
""", encoding="utf-8")

    print("[2/6] Launching DesktopLibraryService HTTPS WebDAV daemon...")
    server_proc = subprocess.Popen(
        ["node", str(server_script)],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        cwd=str(WORKSPACE)
    )

    ready_line = None
    start_t = time.time()
    while time.time() - start_t < 10:
        line = server_proc.stdout.readline()
        if "WEBDAV_SERVER_READY:" in line:
            ready_line = line.strip().split("WEBDAV_SERVER_READY:")[1]
            break
        time.sleep(0.1)

    if not ready_line:
        err = server_proc.stderr.read()
        server_proc.kill()
        raise RuntimeError(f"WebDAV server failed to start: {err}")

    server_info = json.loads(ready_line)
    token = server_info["token"]
    print(f"[+] WebDAV Server listening on port {PORT} with session token: {token[:12]}...")

    try:
        # 3. Connect to Ubuntu VM and sync test source directory
        print("[3/6] Connecting to Ubuntu VM (192.168.80.128) via SSH...")
        ssh = paramiko.SSHClient()
        ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        for attempt in range(5):
            try:
                ssh.connect(UBUNTU_IP, 22, username=VM_USER, password=VM_PASS, timeout=15, banner_timeout=30)
                break
            except Exception as e:
                if attempt == 4:
                    raise
                time.sleep(2)

        # Upload client_src to Ubuntu
        sftp = ssh.open_sftp()
        vm_src_dir = "/tmp/rclone_test_src"
        vm_dst_dir = "/tmp/rclone_test_dst"
        ssh.exec_command(f"rm -rf {vm_src_dir} {vm_dst_dir} && mkdir -p {vm_src_dir}")

        for p in client_src.rglob("*"):
            if p.is_file():
                rel = p.relative_to(client_src).as_posix()
                remote_file = f"{vm_src_dir}/{rel}"
                remote_parent = os.path.dirname(remote_file)
                # Ensure remote directory exists
                ssh.exec_command(f"mkdir -p '{remote_parent}'")
                sftp.put(str(p), remote_file)
        sftp.close()

        # 4. Configure rclone on Ubuntu VM
        rclone_conf = f"""[nearby_dav]
type = webdav
url = https://{HOST_IP}:{PORT}/webdav/test-share
vendor = other
bearer_token = {token}
"""
        ssh.exec_command("mkdir -p ~/.config/rclone")
        stdin, stdout, stderr = ssh.exec_command("cat > ~/.config/rclone/rclone.conf")
        stdin.write(rclone_conf)
        stdin.close()
        stdout.read()

        # 5. Execute rclone operations
        print("[4/6] Executing rclone operations from Ubuntu VM (10 parallel streams, no-check-certificate)...")
        
        # 5.1 Test mkdir
        print("  -> rclone mkdir nearby_dav:rclone_dataset...")
        stdin, stdout, stderr = ssh.exec_command("rclone --no-check-certificate mkdir nearby_dav:rclone_dataset")
        out, err = stdout.read().decode(), stderr.read().decode()
        if stderr.channel.recv_exit_status() != 0:
            print(f"[-] rclone mkdir failed: {err}")
            raise RuntimeError(err)

        # 5.2 Test copy from VM to WebDAV server with 10 parallel transfers
        print("  -> rclone copy to WebDAV server (--transfers=10)...")
        t0 = time.time()
        stdin, stdout, stderr = ssh.exec_command(
            f"rclone --no-check-certificate --transfers=10 --checkers=10 copy '{vm_src_dir}' nearby_dav:rclone_dataset"
        )
        out, err = stdout.read().decode(), stderr.read().decode()
        exit_code = stderr.channel.recv_exit_status()
        t1 = time.time()
        if exit_code != 0:
            print(f"[-] rclone copy upload failed:\nSTDOUT: {out}\nSTDERR: {err}")
            raise RuntimeError(err)
        print(f"  [+] Upload completed in {t1 - t0:.2f}s!")

        # 5.3 Test rclone check
        print("  -> rclone check (verifying remote files match local size/hashes)...")
        stdin, stdout, stderr = ssh.exec_command(
            f"rclone --no-check-certificate check '{vm_src_dir}' nearby_dav:rclone_dataset"
        )
        out, err = stdout.read().decode(), stderr.read().decode()
        exit_code = stderr.channel.recv_exit_status()
        print(f"  rclone check output:\n{out}\n{err}")
        if exit_code != 0:
            print("[-] rclone check failed!")
            raise RuntimeError("rclone check failed")

        # 5.4 Test rclone copy from WebDAV server back to VM local
        print("  -> rclone copy from WebDAV back to VM local folder...")
        stdin, stdout, stderr = ssh.exec_command(
            f"mkdir -p '{vm_dst_dir}' && rclone --no-check-certificate --transfers=10 copy nearby_dav:rclone_dataset '{vm_dst_dir}'"
        )
        out, err = stdout.read().decode(), stderr.read().decode()
        if stderr.channel.recv_exit_status() != 0:
            print(f"[-] rclone copy download failed: {err}")
            raise RuntimeError(err)

        # 5.5 Verify SHA-256 hashes on Ubuntu VM
        print("[5/6] Verifying downloaded SHA-256 hashes on Ubuntu VM...")
        stdin, stdout, stderr = ssh.exec_command(
            f"cd '{vm_dst_dir}' && find . -type f -exec sha256sum {{}} +"
        )
        downloaded_hashes_raw = stdout.read().decode().strip().split("\n")
        downloaded_hashes = {}
        for line in downloaded_hashes_raw:
            if not line.strip():
                continue
            parts = line.strip().split(None, 1)
            h = parts[0]
            fpath = parts[1].lstrip("./")
            downloaded_hashes[fpath] = h

        mismatches = []
        for rel_path, expected_hash in dataset_hashes.items():
            actual = downloaded_hashes.get(rel_path)
            if actual != expected_hash:
                mismatches.append((rel_path, expected_hash, actual))

        if mismatches:
            print(f"[-] Hash mismatches detected: {len(mismatches)}")
            for rel_path, exp, act in mismatches:
                print(f"  {rel_path}: expected {exp[:12]}, got {act[:12] if act else 'NONE'}")
            raise RuntimeError("Hash mismatches found!")
        print(f"  [+] All {len(dataset_hashes)} files matched bit-for-bit (100% SHA-256 verification passed)!")

        # 5.6 Test rclone delete & cleanup
        print("  -> rclone cleanup and deletion...")
        stdin, stdout, stderr = ssh.exec_command(
            "rclone --no-check-certificate delete nearby_dav:rclone_dataset/large_payload_30mb.bin"
        )
        stdout.read()
        server_large = share_dir / "rclone_dataset" / "large_payload_30mb.bin"
        if server_large.exists():
            raise RuntimeError("Deleted file still exists on server!")
        print("  [+] Remote file deletion verified!")

        ssh.exec_command(f"rm -rf {vm_src_dir} {vm_dst_dir}")
        ssh.close()

        print("[6/6] WebDAV & rclone interoperability validation completed successfully!")
        print("=" * 60)
        print("   ALL RCLONE & WEBDAV RFC 4918 TESTS PASSED (100%)   ")
        print("=" * 60)

    finally:
        server_proc.terminate()
        try:
            server_proc.wait(timeout=3)
        except Exception:
            server_proc.kill()
        if SCRATCH.exists():
            shutil.rmtree(SCRATCH, ignore_errors=True)

if __name__ == "__main__":
    main()

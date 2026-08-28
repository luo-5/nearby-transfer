import os
import sys
import tarfile
import paramiko

sys.path.insert(0, os.path.dirname(__file__))
sys.stdout.reconfigure(encoding='utf-8')
sys.stderr.reconfigure(encoding='utf-8')

from vm_client import get_client, exec_cmd

print("[+] Creating workspace tarball including dist/ and node_modules...")
tar_path = os.path.join(os.environ.get('TEMP', 'C:\\Temp'), "nt-winvm-full.tar.gz")

ignore_dirs = {'.git', '.tmp', 'android-app', 'release_artifacts'}
with tarfile.open(tar_path, "w:gz") as tar:
    for root, dirs, files in os.walk('.'):
        dirs[:] = [d for d in dirs if d not in ignore_dirs and not d.startswith('.gradle')]
        for file in files:
            full_path = os.path.join(root, file)
            rel_path = os.path.relpath(full_path, '.')
            tar.add(full_path, arcname=rel_path)

tar_mb = os.path.getsize(tar_path) / (1024 * 1024)
print(f"  Tarball size: {tar_mb:.2f} MB")

print("  Uploading tarball to Windows VM via SFTP...")
ssh = get_client('winvm')
sftp = ssh.open_sftp()
sftp.put(tar_path, "C:/Users/31752/nt-winvm-full.tar.gz")
sftp.close()
ssh.close()

print("  Extracting tarball on Windows VM...")
extract_cmd = 'cmd /c "if not exist C:\\Users\\31752\\nearby-transfer mkdir C:\\Users\\31752\\nearby-transfer && tar -xzf C:\\Users\\31752\\nt-winvm-full.tar.gz -C C:\\Users\\31752\\nearby-transfer"'
code, out, err = exec_cmd('winvm', extract_cmd, timeout=120)
print(f"  Extract Code: {code}")

print("  Verifying dist files on Windows VM...")
check_cmd = 'cmd /c "dir C:\\Users\\31752\\nearby-transfer\\packages\\core\\dist"'
code, out, err = exec_cmd('winvm', check_cmd, timeout=30)
print(f"  Dist check Code: {code}")
print(out)

print("  Testing vm-agent.mjs on Windows VM...")
agent_cmd = 'cmd /c "node C:\\Users\\31752\\nearby-transfer\\scripts\\vm-agent.mjs generate --type single --size 1024 --out C:\\Users\\31752\\test_gen"'
code, out, err = exec_cmd('winvm', agent_cmd, timeout=30)
print(f"  Agent test Code: {code}")
print(out)

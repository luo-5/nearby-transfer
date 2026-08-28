import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
sys.stdout.reconfigure(encoding='utf-8')
from vm_client import get_client, exec_cmd

print("[+] Setting up CentOS nearby-transfer repository...")
# Check if git clone or upload tarball is faster
tar_path = os.path.join(os.environ.get('TEMP', '/tmp'), "nearby-transfer-sync.tar.gz")
print("  Uploading tarball to CentOS via SFTP...")
ssh = get_client('centos')
sftp = ssh.open_sftp()
sftp.put(tar_path, "/home/l/nt-sync.tar.gz")
sftp.close()
ssh.close()

print("  Extracting and building on CentOS...")
cmd = """
mkdir -p /home/l/nearby-transfer
tar -xzf /home/l/nt-sync.tar.gz -C /home/l/nearby-transfer
cd /home/l/nearby-transfer
npm run build:core
npm run build --workspace @luo-5/cli
"""
code, out, err = exec_cmd('centos', cmd, timeout=120)
print(f"[CENTOS] Code: {code}")
print(f"Output:\n{out}")
if err:
    print(f"Error:\n{err}")


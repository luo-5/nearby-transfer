import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
sys.stdout.reconfigure(encoding='utf-8')
from vm_client import get_client, exec_cmd

exec_cmd('winvm', 'powershell -Command "mkdir C:\\Users\\31752\\nearby-transfer\\scripts -Force"')

for vm, remote_path in [
    ('ubuntu', '/home/l/nearby-transfer/scripts/vm-agent.mjs'),
    ('centos', '/home/l/nearby-transfer/scripts/vm-agent.mjs'),
    ('winvm', 'C:/Users/31752/nearby-transfer/scripts/vm-agent.mjs')
]:
    ssh = get_client(vm)
    sftp = ssh.open_sftp()
    sftp.put(os.path.join(os.path.dirname(__file__), 'vm-agent.mjs'), remote_path)
    sftp.close()
    ssh.close()
    print(f"[+] Synced vm-agent.mjs to {vm.upper()}")

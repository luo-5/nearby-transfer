import os
import paramiko

vms = [
    ('Ubuntu', os.getenv('VM_UBUNTU_HOST'), os.getenv('VM_USER', 'l'), os.getenv('VM_PASS'), os.getenv('VM_SSH_KEY'), 'pwd; which node; node -v; which npm; npm -v; git --version'),
    ('CentOS', os.getenv('VM_CENTOS_HOST'), os.getenv('VM_USER', 'l'), os.getenv('VM_PASS'), os.getenv('VM_SSH_KEY'), 'pwd; which node; node -v; which npm; npm -v; git --version'),
    ('Windows VM', os.getenv('VM_WIN_HOST'), os.getenv('WIN_USER'), os.getenv('WIN_PASS'), os.getenv('WIN_SSH_KEY'), 'cd & where node & node -v & where npm & npm -v & where git')
]

for name, host, user, password, key, cmd in vms:
    if not host or not user:
        print(f"[SKIP] {name}: host/user environment is not configured")
        continue
    try:
        ssh = paramiko.SSHClient()
        ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        ssh.connect(
            host, port=22, username=user, password=password, key_filename=key,
            allow_agent=not bool(password), look_for_keys=not bool(password), timeout=8,
        )
        stdin, stdout, stderr = ssh.exec_command(cmd)
        out = stdout.read().decode('utf-8', errors='ignore').strip()
        err = stderr.read().decode('utf-8', errors='ignore').strip()
        print(f"=== {name} ({host}) ===\n{out}\n{err}\n")
        ssh.close()
    except Exception as e:
        print(f"[FAIL] {name} ({host}): {e}\n")

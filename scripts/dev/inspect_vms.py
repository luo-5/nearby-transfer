import paramiko

vms = [
    ('Ubuntu', '192.168.80.128', 'l', '123', 'pwd; which node; node -v; which npm; npm -v; git --version; find ~ -maxdepth 3 -name "nearby-transfer*" -o -name "pr*" 2>/dev/null'),
    ('CentOS', '192.168.80.130', 'l', '123', 'pwd; which node; node -v; which npm; npm -v; git --version; find ~ -maxdepth 3 -name "nearby-transfer*" -o -name "pr*" 2>/dev/null'),
    ('Windows VM', '192.168.80.129', '31752', '123', 'cd & where node & node -v & where npm & npm -v & where git & dir /s /b C:\\Users\\31752\\*nearby-transfer* 2>nul')
]

for name, host, user, pwd, cmd in vms:
    try:
        ssh = paramiko.SSHClient()
        ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        ssh.connect(host, port=22, username=user, password=pwd, timeout=8)
        stdin, stdout, stderr = ssh.exec_command(cmd)
        out = stdout.read().decode('utf-8', errors='ignore').strip()
        err = stderr.read().decode('utf-8', errors='ignore').strip()
        print(f"=== {name} ({host}) ===\n{out}\n{err}\n")
        ssh.close()
    except Exception as e:
        print(f"[FAIL] {name} ({host}): {e}\n")

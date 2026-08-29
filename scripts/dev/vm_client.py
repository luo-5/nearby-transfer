import sys
import os
import tarfile
import tempfile
import paramiko

VM_CONFIGS = {
    'ubuntu': {
        'host': os.getenv('VM_UBUNTU_HOST'),
        'user': os.getenv('VM_USER', 'l'),
        'pass': os.getenv('VM_PASS'),
        'key': os.getenv('VM_SSH_KEY'),
        'os': 'linux',
        'repo_dir': '/home/l/nearby-transfer'
    },
    'centos': {
        'host': os.getenv('VM_CENTOS_HOST'),
        'user': os.getenv('VM_USER', 'l'),
        'pass': os.getenv('VM_PASS'),
        'key': os.getenv('VM_SSH_KEY'),
        'os': 'linux',
        'repo_dir': '/home/l/nearby-transfer'
    },
    'winvm': {
        'host': os.getenv('VM_WIN_HOST'),
        'user': os.getenv('WIN_USER'),
        'pass': os.getenv('WIN_PASS'),
        'key': os.getenv('WIN_SSH_KEY'),
        'os': 'windows',
        'repo_dir': 'C:\\Users\\31752\\nearby-transfer'
    }
}

def get_client(vm_name):
    cfg = VM_CONFIGS[vm_name]
    if not cfg['host'] or not cfg['user']:
        raise RuntimeError(f"Missing host or user configuration for {vm_name}")
    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    ssh.connect(
        cfg['host'], port=22, username=cfg['user'], password=cfg['pass'],
        key_filename=cfg['key'], allow_agent=not bool(cfg['pass']),
        look_for_keys=not bool(cfg['pass']), timeout=15, banner_timeout=30,
        auth_timeout=30,
    )
    return ssh

def exec_cmd(vm_name, cmd, timeout=30):
    ssh = get_client(vm_name)
    try:
        stdin, stdout, stderr = ssh.exec_command(cmd, timeout=timeout)
        out = stdout.read().decode('utf-8', errors='replace')
        err = stderr.read().decode('utf-8', errors='replace')
        exit_code = stdout.channel.recv_exit_status()
        return exit_code, out, err
    finally:
        ssh.close()

if __name__ == '__main__':
    for vm in ['ubuntu', 'centos', 'winvm']:
        try:
            code, out, err = exec_cmd(vm, 'whoami')
            print(f"[{vm.upper()}] whoami -> {out.strip()} (code: {code})")
        except Exception as e:
            print(f"[{vm.upper()}] Error: {e}")

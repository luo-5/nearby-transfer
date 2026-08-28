import os
import sys
import tarfile
import tempfile
import paramiko

sys.stdout.reconfigure(encoding='utf-8')
sys.stderr.reconfigure(encoding='utf-8')

from vm_client import VM_CONFIGS, get_client, exec_cmd

def sync_linux_repo(vm_name):
    print(f"\n[+] Syncing repository to {vm_name.upper()}...")
    cmd = """
    cd /home/l/nearby-transfer && \
    git fetch origin main && \
    git checkout main && \
    git reset --hard origin/main && \
    git log -1 --oneline && \
    npm run build:core && \
    npm run build --workspace @luo-5/cli
    """
    code, out, err = exec_cmd(vm_name, cmd, timeout=120)
    print(f"[{vm_name.upper()}] Exit Code: {code}")
    print(f"Output:\n{out}")
    if err and code != 0:
        print(f"Error:\n{err}")
    return code == 0

def pack_and_sync_windows_repo():
    print("\n[+] Packing local workspace for Windows VM...")
    tar_path = os.path.join(tempfile.gettempdir(), "nearby-transfer-sync.tar.gz")
    
    ignore_dirs = {'.git', 'node_modules', '.tmp', 'android-app', 'release_artifacts'}
    
    with tarfile.open(tar_path, "w:gz") as tar:
        for root, dirs, files in os.walk('.'):
            # filter dirs in place
            dirs[:] = [d for d in dirs if d not in ignore_dirs and not d.startswith('.gradle')]
            for file in files:
                full_path = os.path.join(root, file)
                rel_path = os.path.relpath(full_path, '.')
                tar.add(full_path, arcname=rel_path)
                
    tar_size_mb = os.path.getsize(tar_path) / (1024 * 1024)
    print(f"  Tarball created: {tar_path} ({tar_size_mb:.2f} MB)")
    
    print("  Uploading tarball to Windows VM via SFTP...")
    ssh = get_client('winvm')
    sftp = ssh.open_sftp()
    sftp.put(tar_path, "C:\\Users\\31752\\nt-sync.tar.gz")
    sftp.close()
    ssh.close()
    
    print("  Extracting tarball on Windows VM and building...")
    ps_cmd = """powershell -Command "
        $target = 'C:\\Users\\31752\\nearby-transfer';
        if (-not (Test-Path $target)) { New-Item -ItemType Directory -Path $target -Force };
        tar -xzf C:\\Users\\31752\\nt-sync.tar.gz -C $target;
        cd $target;
        npm run build:core;
        npm run build --workspace @luo-5/cli
    " """
    code, out, err = exec_cmd('winvm', ps_cmd, timeout=120)
    print(f"[WINVM] Exit Code: {code}")
    print(f"Output:\n{out}")
    if err and code != 0:
        print(f"Error:\n{err}")
    return code == 0

if __name__ == '__main__':
    ok_u = sync_linux_repo('ubuntu')
    ok_c = sync_linux_repo('centos')
    ok_w = pack_and_sync_windows_repo()
    print(f"\n=== Sync Summary: Ubuntu={ok_u}, CentOS={ok_c}, WinVM={ok_w} ===")

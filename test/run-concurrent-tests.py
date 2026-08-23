#!/usr/bin/env python3
"""Concurrent test: multi-device simultaneous transfer + simultaneous library access."""
import paramiko, subprocess, json, time, os, hashlib, tempfile

TMP = tempfile.gettempdir()
REPO = r"D:\github项目\pr\pr\nearby-transfer-next-version"
CENTOS = {"ip": "192.168.105.129", "name": "centos"}
UBUNTU = {"ip": "192.168.105.128", "name": "ubuntu"}
WINDOWS = {"ip": "192.168.105.1", "name": "windows", "local": True}

def ssh(ip):
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(ip, port=22, username="l", password="123", timeout=10, allow_agent=False, look_for_keys=False)
    return c

def ssh_run(c, cmd, t=120):
    _, out, _ = c.exec_command(f"cd ~/nearby-transfer && {cmd}", timeout=t, get_pty=True)
    return out.read().decode(errors="replace")

def ssh_cat(c, path):
    s = c.open_sftp()
    try:
        with s.file(path, "r") as f: return f.read().decode()
    finally: s.close()

def ssh_put(c, path, content):
    s = c.open_sftp()
    try:
        with s.file(path, "w") as f: f.write(content)
    finally: s.close()

def local_run(cmd, t=120):
    r = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=t, cwd=REPO)
    return r.stdout

def is_local(m): return m.get("local", False)

def get_identity(machine):
    if is_local(machine):
        p = os.path.join(TMP, "nt-sender-id.json")
        with open(p) as f: return f.read().strip()
    else:
        c = ssh(machine["ip"])
        content = ssh_cat(c, "/tmp/nt-sender-id.json")
        c.close()
        return content.strip()

def put_file(machine, path, content):
    if is_local(machine):
        with open(path, "w") as f: f.write(content)
    else:
        c = ssh(machine["ip"])
        ssh_put(c, path, content)
        c.close()

def make_test_file(machine, name):
    if is_local(machine):
        d = os.path.join(TMP, "nt-send"); os.makedirs(d, exist_ok=True)
        p = os.path.join(d, name)
        data = os.urandom(3*1024*1024)
        with open(p, "wb") as f: f.write(data)
        return p, hashlib.sha256(data).hexdigest()
    else:
        c = ssh(machine["ip"])
        ssh_run(c, f"mkdir -p /tmp/nt-send && dd if=/dev/urandom of=/tmp/nt-send/{name} bs=1M count=3 2>/dev/null", 30)
        _, out, _ = c.exec_command(f"sha256sum /tmp/nt-send/{name}", timeout=15)
        sha = out.read().decode().strip().split()[0]
        c.close()
        return f"/tmp/nt-send/{name}", sha

def parse_result(out, role):
    for line in out.splitlines():
        if '"RESULT"' in line and f'"{role}"' in line:
            try: return json.loads(line.strip())
            except: pass
    return {"result": "fail", "error": "no RESULT"}

results = []

# === CONCURRENT TEST 1: Two senders -> one receiver simultaneously ===
print(f"\n{'='*60}")
print("CONCURRENT TEST 1: Concurrent transfers (Ubuntu+CentOS -> Windows)")
print(f"{'='*60}")

print("  [1] Starting Windows receiver...")
tag = "-conc1"
win_recv_dir = os.path.join(TMP, f"nt-cross-recv{tag}")
os.makedirs(win_recv_dir, exist_ok=True)
ubuntu_id = get_identity(UBUNTU)
centos_id = get_identity(CENTOS)
# Write both sender identities as separate files, pass comma-separated to receiver
put_file(WINDOWS, os.path.join(TMP, f"nt-peer-sender-u{tag}.json"), ubuntu_id)
put_file(WINDOWS, os.path.join(TMP, f"nt-peer-sender-c{tag}.json"), centos_id)
sender_files = f'{os.path.join(TMP, f"nt-peer-sender-u{tag}.json")},{os.path.join(TMP, f"nt-peer-sender-c{tag}.json")}'
win_log = os.path.join(TMP, f"nt-recv-bg{tag}.log")
with open(win_log, "w") as lf:
    proc = subprocess.Popen(
        f'node test/cross-machine-transfer.js receiver --port 50201 --receive-dir "{win_recv_dir}" '
        f'--identity-file "{os.path.join(TMP, "nt-recv-id.json")}" '
        f'--sender-identity-file "{sender_files}"',
        shell=True, stdout=lf, stderr=subprocess.STDOUT, cwd=REPO)
time.sleep(3)

with open(win_log) as f: log_content = f.read()
win_recv_id = None
for line in log_content.splitlines():
    if '"RECEIVER_IDENTITY"' in line:
        win_recv_id = line.strip(); break

put_file(UBUNTU, f"/tmp/nt-peer-recv-identity{tag}.json", win_recv_id)
put_file(CENTOS, f"/tmp/nt-peer-recv-identity{tag}.json", win_recv_id)

u_file, u_sha = make_test_file(UBUNTU, "concurrent-ubuntu.bin")
c_file, c_sha = make_test_file(CENTOS, "concurrent-centos.bin")
print(f"  Ubuntu file SHA: {u_sha[:16]}...")
print(f"  CentOS file SHA: {c_sha[:16]}...")

print("  [2] Launching concurrent senders (Ubuntu + CentOS)...")
cu = ssh(UBUNTU["ip"])
u_thread = cu.exec_command(
    f"cd ~/nearby-transfer && node test/cross-machine-transfer.js sender "
    f"--host 192.168.105.1 --port 50201 --file {u_file} "
    f"--identity-file /tmp/nt-sender-id.json --peer-identity-file /tmp/nt-peer-recv-identity{tag}.json 2>&1",
    timeout=60)

cc = ssh(CENTOS["ip"])
c_thread = cc.exec_command(
    f"cd ~/nearby-transfer && node test/cross-machine-transfer.js sender "
    f"--host 192.168.105.1 --port 50201 --file {c_file} "
    f"--identity-file /tmp/nt-sender-id.json --peer-identity-file /tmp/nt-peer-recv-identity{tag}.json 2>&1",
    timeout=60)

u_out = u_thread[1].read().decode(errors="replace")
c_out = c_thread[1].read().decode(errors="replace")
cu.close(); cc.close()

u_result = parse_result(u_out, "sender")
c_result = parse_result(c_out, "sender")
print(f"  Ubuntu sender: {u_result.get('result','?')}")
print(f"  CentOS sender: {c_result.get('result','?')}")

time.sleep(3)
found_u = []
found_c = []
for root, dirs, files in os.walk(win_recv_dir):
    if ".nearby-transfer-staging" in root: continue
    for fn in files:
        fp = os.path.join(root, fn)
        try:
            with open(fp, "rb") as f:
                sha = hashlib.sha256(f.read()).hexdigest()
            if sha == u_sha: found_u.append(fp)
            if sha == c_sha: found_c.append(fp)
        except: pass

print(f"  Ubuntu file received: {'YES' if found_u else 'NO'}")
print(f"  CentOS file received: {'YES' if found_c else 'NO'}")

both_ok = u_result.get("result")=="ok" and c_result.get("result")=="ok" and found_u and found_c
r1 = {"label": "Concurrent Transfer (Ubuntu+CentOS->Windows)", "overall": "PASS" if both_ok else "FAIL",
      "ubuntu_sender": u_result.get("result"), "centos_sender": c_result.get("result"),
      "ubuntu_sha256": bool(found_u), "centos_sha256": bool(found_c)}
if not both_ok:
    r1["error"] = f"u={u_result.get('result')}/{bool(found_u)} c={c_result.get('result')}/{bool(found_c)}"
results.append(r1)
print(f"  => {r1['overall']}")

try: proc.terminate(); proc.wait(timeout=5)
except:
    try: proc.kill()
    except: pass

# === CONCURRENT TEST 2: Two clients access library simultaneously ===
print(f"\n{'='*60}")
print("CONCURRENT TEST 2: Concurrent library access (Ubuntu+CentOS -> Windows)")
print(f"{'='*60}")

print("  [1] Starting Windows library servers...")
ubuntu_id_full = get_identity(UBUNTU)
centos_id_full = get_identity(CENTOS)

# Server 1 for Ubuntu (port 56610)
tag1 = "-conc2u"
put_file(WINDOWS, os.path.join(TMP, f"nt-lib-client-id{tag1}.json"), ubuntu_id_full)
lib_dir1 = os.path.join(TMP, f"nt-library{tag1}")
os.makedirs(lib_dir1, exist_ok=True)
lib_log1 = os.path.join(TMP, f"nt-libserver{tag1}.log")
with open(lib_log1, "w") as lf:
    proc1 = subprocess.Popen(
        f'node test/library-server.js --port 56610 --share-dir "{lib_dir1}" '
        f'--client-identity-file "{os.path.join(TMP, f"nt-lib-client-id{tag1}.json")}"',
        shell=True, stdout=lf, stderr=subprocess.STDOUT, cwd=REPO)

# Server 2 for CentOS (port 56611)
tag2 = "-conc2c"
put_file(WINDOWS, os.path.join(TMP, f"nt-lib-client-id{tag2}.json"), centos_id_full)
lib_dir2 = os.path.join(TMP, f"nt-library{tag2}")
os.makedirs(lib_dir2, exist_ok=True)
lib_log2 = os.path.join(TMP, f"nt-libserver{tag2}.log")
with open(lib_log2, "w") as lf:
    proc2 = subprocess.Popen(
        f'node test/library-server.js --port 56611 --share-dir "{lib_dir2}" '
        f'--client-identity-file "{os.path.join(TMP, f"nt-lib-client-id{tag2}.json")}"',
        shell=True, stdout=lf, stderr=subprocess.STDOUT, cwd=REPO)

time.sleep(3)

print("  [2] Launching concurrent library clients...")
cu2 = ssh(UBUNTU["ip"])
u_lib_thread = cu2.exec_command(
    "cd ~/nearby-transfer && node test/cross-library-test.js "
    "--host 192.168.105.1 --port 56610 "
    "--identity-file /tmp/nt-sender-id.json --peer-identity-file /tmp/nt-sender-id.json 2>&1",
    timeout=60)

cc2 = ssh(CENTOS["ip"])
c_lib_thread = cc2.exec_command(
    "cd ~/nearby-transfer && node test/cross-library-test.js "
    "--host 192.168.105.1 --port 56611 "
    "--identity-file /tmp/nt-sender-id.json --peer-identity-file /tmp/nt-sender-id.json 2>&1",
    timeout=60)

u_lib_out = u_lib_thread[1].read().decode(errors="replace")
c_lib_out = c_lib_thread[1].read().decode(errors="replace")
cu2.close(); cc2.close()

u_lib = parse_result(u_lib_out, "library-client")
c_lib = parse_result(c_lib_out, "library-client")
print(f"  Ubuntu library client: {u_lib.get('result','?')}")
print(f"  CentOS library client: {c_lib.get('result','?')}")

both_lib_ok = u_lib.get("result")=="ok" and c_lib.get("result")=="ok"
r2 = {"label": "Concurrent Library (Ubuntu+CentOS->Windows)", "overall": "PASS" if both_lib_ok else "FAIL",
      "ubuntu_client": u_lib.get("result"), "centos_client": c_lib.get("result")}
if not both_lib_ok:
    r2["error"] = f"u={u_lib.get('result')} c={c_lib.get('result')}"
results.append(r2)
print(f"  => {r2['overall']}")

try: proc1.terminate(); proc1.wait(timeout=5)
except:
    try: proc1.kill()
    except: pass
try: proc2.terminate(); proc2.wait(timeout=5)
except:
    try: proc2.kill()
    except: pass

# Final report
print(f"\n{'='*60}")
print("CONCURRENT TEST REPORT")
print(f"{'='*60}")
print(f"{'Test':<50} {'Result':<8}")
print("-"*60)
for r in results:
    print(f"{r['label']:<50} {r.get('overall','?'):<8}")
p = sum(1 for r in results if r.get("overall")=="PASS")
print(f"\n{p}/{len(results)} passed")
with open(os.path.join(REPO, "test", "concurrent-test-report.json"), "w") as f:
    json.dump(results, f, indent=2, default=str)

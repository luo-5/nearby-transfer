#!/usr/bin/env python3
"""Cross-machine transfer test — inline v3."""
import paramiko, subprocess, json, time, os, hashlib, tempfile

TMP = tempfile.gettempdir()
REPO = os.getenv("NT_LOCAL_REPO", os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
CENTOS = {"ip": os.getenv("NT_CENTOS_IP"), "name": "centos"}
UBUNTU = {"ip": os.getenv("NT_UBUNTU_IP"), "name": "ubuntu"}
WINDOWS = {"ip": os.getenv("NT_WINDOWS_IP"), "name": "windows", "local": True}
SSH_USER = os.getenv("NT_VM_SSH_USER", "l")
SSH_PASSWORD = os.getenv("NT_VM_SSH_PASSWORD")
SSH_KEY = os.getenv("NT_VM_SSH_KEY")

def ssh(ip):
    if not ip:
        raise RuntimeError("VM IP is not configured")
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(
        ip,
        port=22,
        username=SSH_USER,
        password=SSH_PASSWORD,
        key_filename=SSH_KEY,
        timeout=10,
        allow_agent=not bool(SSH_PASSWORD),
        look_for_keys=not bool(SSH_PASSWORD),
    )
    return c

def ssh_run(c, cmd, t=120):
    _, out, _ = c.exec_command(f"cd ~/nearby-transfer && {cmd}", timeout=t, get_pty=True)
    return out.read().decode(errors="replace")

def ssh_bg(c, cmd, log):
    c.exec_command(f"cd ~/nearby-transfer && ({cmd}) > {log} 2>&1 &", timeout=10)

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

def get_identity_json(machine, role):
    path = f"/tmp/nt-{role}-identity.json" if not is_local(machine) else os.path.join(TMP, f"nt-{role}-identity.json")
    if is_local(machine):
        if os.path.exists(path):
            with open(path) as f: return f.read().strip()
        return None
    else:
        c = ssh(machine["ip"])
        try:
            content = ssh_cat(c, path)
            c.close()
            return content.strip() if content.strip() else None
        except:
            c.close()
            return None

def put_peer_identity(machine, identity_json, peer_role, tag=""):
    fname = f"nt-peer-{peer_role}-identity{tag}.json"
    if is_local(machine):
        p = os.path.join(TMP, fname)
        with open(p, "w") as f: f.write(identity_json + "\n")
    else:
        c = ssh(machine["ip"])
        ssh_put(c, f"/tmp/{fname}", identity_json + "\n")
        c.close()

def make_test_file(machine):
    if is_local(machine):
        d = os.path.join(TMP, "nt-send"); os.makedirs(d, exist_ok=True)
        p = os.path.join(d, "test-cross.bin")
        data = os.urandom(5*1024*1024)
        with open(p, "wb") as f: f.write(data)
        return p, hashlib.sha256(data).hexdigest()
    else:
        c = ssh(machine["ip"])
        ssh_run(c, "mkdir -p /tmp/nt-send && dd if=/dev/urandom of=/tmp/nt-send/test-cross.bin bs=1M count=5 2>/dev/null", 30)
        _, out, _ = c.exec_command("sha256sum /tmp/nt-send/test-cross.bin", timeout=15)
        sha = out.read().decode().strip().split()[0]
        c.close()
        return "/tmp/nt-send/test-cross.bin", sha

def start_receiver(machine, port, sender_id_json):
    tag = f"-{port}"
    recv_dir = (os.path.join(TMP, f"nt-cross-recv{tag}") if is_local(machine) else f"/tmp/nt-cross-recv{tag}")
    put_peer_identity(machine, sender_id_json, "sender", tag)
    idfile = os.path.join(TMP, "nt-recv-id.json") if is_local(machine) else "/tmp/nt-recv-id.json"
    sender_path = (os.path.join(TMP, f"nt-peer-sender-identity{tag}.json") if is_local(machine) else f"/tmp/nt-peer-sender-identity{tag}.json")
    logfile = (os.path.join(TMP, f"nt-recv-bg{tag}.log") if is_local(machine) else f"/tmp/nt-recv-bg{tag}.log")
    if is_local(machine):
        os.makedirs(recv_dir, exist_ok=True)
        with open(logfile, "w") as lf:
            proc = subprocess.Popen(
                f'node test/cross-machine-transfer.js receiver --port {port} --receive-dir "{recv_dir}" --identity-file "{idfile}" --sender-identity-file "{sender_path}"',
                shell=True, stdout=lf, stderr=subprocess.STDOUT, cwd=REPO)
        return ("local", logfile, proc)
    else:
        c = ssh(machine["ip"])
        ssh_run(c, f"rm -rf {recv_dir} && mkdir -p {recv_dir}", 10)
        ssh_bg(c, f"node test/cross-machine-transfer.js receiver --port {port} --receive-dir {recv_dir} --identity-file {idfile} --sender-identity-file {sender_path}", logfile)
        c.close()
        return ("remote", machine, logfile)

def run_sender(machine, host, port, fpath, recv_id_json):
    # recv identity already placed by test() via the tag-specific path
    tag = f"-{port}"
    idfile = os.path.join(TMP, "nt-sender-id.json") if is_local(machine) else "/tmp/nt-sender-id.json"
    recv_path = (os.path.join(TMP, f"nt-peer-recv-identity{tag}.json") if is_local(machine) else f"/tmp/nt-peer-recv-identity{tag}.json")
    if is_local(machine):
        out = local_run(f'node test/cross-machine-transfer.js sender --host {host} --port {port} --file "{fpath}" --identity-file "{idfile}" --peer-identity-file "{recv_path}"', 120)
    else:
        c = ssh(machine["ip"])
        out = ssh_run(c, f"node test/cross-machine-transfer.js sender --host {host} --port {port} --file {fpath} --identity-file {idfile} --peer-identity-file {recv_path}", 120)
        c.close()
    for line in out.splitlines():
        if '"RESULT"' in line and '"sender"' in line:
            try: return json.loads(line.strip())
            except: pass
    return {"result": "fail", "error": "no RESULT", "tail": out[-200:]}

def get_recv_result(loginfo, t=45):
    deadline = time.time() + t
    while time.time() < deadline:
        if loginfo[0] == "local":
            try:
                with open(loginfo[1]) as f: content = f.read()
            except: content = ""
        else:
            c = ssh(loginfo[1]["ip"])
            _, out, _ = c.exec_command(f"cat {loginfo[2]}", timeout=15)
            content = out.read().decode(errors="replace")
            c.close()
        for line in content.splitlines():
            if '"RESULT"' in line and '"receiver"' in line:
                try: return json.loads(line.strip())
                except: pass
        time.sleep(2)
    return {"result": "fail", "error": "timeout"}

def verify_sha(machine, recv_dir, sha):
    if is_local(machine):
        for root, dirs, files in os.walk(recv_dir):
            if ".nearby-transfer-staging" in root: continue
            for fn in files:
                fp = os.path.join(root, fn)
                try:
                    with open(fp, "rb") as f:
                        if hashlib.sha256(f.read()).hexdigest() == sha: return [fp]
                except: pass
        return []
    else:
        c = ssh(machine["ip"])
        cmd = f'find {recv_dir} -type f ! -path "*/.nearby-transfer-staging*" -exec sha256sum {{}} \\; 2>/dev/null | grep {sha}'
        _, out, _ = c.exec_command(cmd, timeout=30)
        r = out.read().decode().strip()
        c.close()
        return [l.split()[-1] for l in r.splitlines() if sha in l]

def stop_recv(loginfo):
    if loginfo[0] == "local":
        try: loginfo[2].terminate(); loginfo[2].wait(timeout=5)
        except:
            try: loginfo[2].kill()
            except: pass
    else:
        c = ssh(loginfo[1]["ip"])
        c.exec_command("pkill -f 'cross-machine-transfer.js receiver'", timeout=5)
        c.close()

def test(sender, receiver, port, label):
    print(f"\n{'='*55}\n  {label}: {sender['name']} -> {receiver['name']}\n{'='*55}")
    r = {"label": label, "sender": sender["name"], "receiver": receiver["name"]}
    sid = get_identity_json(sender, "sender")
    if not sid:
        r["overall"] = "FAIL"; r["error"] = "missing sender identity"
        print(f"  FAIL: {r['error']}"); return r

    tag = f"-{port}"
    recv_dir = (os.path.join(TMP, f"nt-cross-recv{tag}") if is_local(receiver) else f"/tmp/nt-cross-recv{tag}")

    # Start receiver with sender identity
    loginfo = start_receiver(receiver, port, sid)
    time.sleep(3)

    # Extract receiver identity from the receiver's startup log
    if loginfo[0] == "local":
        try:
            with open(loginfo[1]) as f: log_content = f.read()
        except: log_content = ""
    else:
        c = ssh(loginfo[1]["ip"])
        _, out, _ = c.exec_command(f"cat {loginfo[2]}", timeout=15)
        log_content = out.read().decode(errors="replace")
        c.close()

    rid = None
    for line in log_content.splitlines():
        if '"RECEIVER_IDENTITY"' in line:
            rid = line.strip()
            break
    if not rid:
        r["overall"] = "FAIL"; r["error"] = "receiver didn't print identity"
        print(f"  FAIL: {r['error']}"); stop_recv(loginfo); return r

    # Save receiver identity to a file that sender can read
    rid_path = (os.path.join(TMP, f"nt-peer-recv-identity{tag}.json") if is_local(sender) else f"/tmp/nt-peer-recv-identity{tag}.json")
    if is_local(sender):
        with open(rid_path, "w") as f: f.write(rid + "\n")
    else:
        c = ssh(sender["ip"])
        ssh_put(c, rid_path, rid + "\n")
        c.close()

    fpath, sha = make_test_file(sender)
    print(f"  file SHA: {sha[:16]}...")

    sr = run_sender(sender, receiver["ip"], port, fpath, rid)
    print(f"  sender: {sr.get('result','?')}")

    rr = get_recv_result(loginfo, 45)
    print(f"  receiver: {rr.get('result','?')}")

    found = verify_sha(receiver, recv_dir, sha)
    print(f"  SHA256: {'YES' if found else 'NO'}")

    stop_recv(loginfo)

    ok = sr.get("result") == "ok" and bool(found)
    r["sender_result"] = sr.get("result"); r["receiver_result"] = rr.get("result")
    r["sha256_verified"] = bool(found); r["overall"] = "PASS" if ok else "FAIL"
    if not ok: r["error"] = sr.get("error","") or rr.get("error","")
    print(f"  => {r['overall']}")
    return r

if __name__ == "__main__":
    # Clean up VMs first
    for ip in [machine["ip"] for machine in (UBUNTU, CENTOS) if machine["ip"]]:
        try:
            c = ssh(ip)
            c.exec_command("pkill -f cross-machine-transfer 2>/dev/null", timeout=5)
            c.close()
        except: pass
    time.sleep(2)

    results = []
    for s, rc, p, lbl in [
        (UBUNTU, CENTOS, 50101, "Ubuntu->CentOS"),
        (CENTOS, UBUNTU, 50102, "CentOS->Ubuntu"),
        (UBUNTU, WINDOWS, 50103, "Ubuntu->Windows"),
        (WINDOWS, UBUNTU, 50104, "Windows->Ubuntu"),
        (CENTOS, WINDOWS, 50105, "CentOS->Windows"),
        (WINDOWS, CENTOS, 50106, "Windows->CentOS"),
    ]:
        try:
            results.append(test(s, rc, p, lbl))
        except Exception as e:
            results.append({"label": lbl, "overall": "FAIL", "error": str(e)})
            print(f"  EXCEPTION: {e}")
        time.sleep(2)

    print(f"\n{'='*55}\nFINAL REPORT\n{'='*55}")
    print(f"{'Test':<20} {'Result':<8} {'SHA256':<8} {'Error'}")
    print("-"*55)
    for r in results:
        print(f"{r['label']:<20} {r.get('overall','?'):<8} {'Y' if r.get('sha256_verified') else 'N':<8} {r.get('error','')[:30]}")
    p = sum(1 for r in results if r.get("overall")=="PASS")
    print(f"\n{p}/{len(results)} passed")
    with open(os.path.join(REPO, "test", "cross-machine-report.json"), "w") as f:
        json.dump(results, f, indent=2, default=str)

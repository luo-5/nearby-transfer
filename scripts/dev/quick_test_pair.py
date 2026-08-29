import os
import sys
import time
import threading

sys.path.insert(0, os.path.dirname(__file__))
sys.stdout.reconfigure(encoding='utf-8')
from vm_client import exec_cmd

print("[1] Generating payload on Ubuntu...")
code, out, err = exec_cmd('ubuntu', 'node /home/l/nearby-transfer/scripts/vm-agent.mjs generate --type single --size 65536 --out /tmp/s_test')
print(f"Gen: {out.strip()}")

print("[2] Starting receiver on CentOS (192.168.80.130:47805)...")
recv_res = {}
def recv_thread():
    code, out, err = exec_cmd('centos', 'node /home/l/nearby-transfer/scripts/vm-agent.mjs recv --dir /tmp/r_test --port 47805 --node-name centos', timeout=30)
    recv_res['out'] = out
    recv_res['err'] = err
    recv_res['code'] = code

t = threading.Thread(target=recv_thread)
t.start()
time.sleep(2)

print("[3] Starting sender on Ubuntu...")
code, out, err = exec_cmd('ubuntu', 'node /home/l/nearby-transfer/scripts/vm-agent.mjs send --to 192.168.80.130 --port 47805 --input /tmp/s_test --sender-node ubuntu --receiver-node centos', timeout=30)
print(f"Sender out: {out.strip()}, err: {err.strip()}")

t.join(timeout=30)
print(f"Recv out: {recv_res.get('out','').strip()}, err: {recv_res.get('err','').strip()}")

import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
sys.stdout.reconfigure(encoding='utf-8')
from vm_client import exec_cmd

cmd = """powershell -Command "
    cd C:\\Users\\31752\\nearby-transfer;
    npm run build:core;
    npm run build --workspace @luo-5/cli;
    Get-ChildItem C:\\Users\\31752\\nearby-transfer\\packages\\core\\dist
" """
code, out, err = exec_cmd('winvm', cmd, timeout=120)
print(f"Code: {code}")
print(f"Out:\n{out}")
if err:
    print(f"Err:\n{err}")

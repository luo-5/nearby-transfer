import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
sys.stdout.reconfigure(encoding='utf-8')
from vm_client import exec_cmd

cmd = """powershell -Command "
    Write-Host 'Checking path...';
    Test-Path 'C:\\Users\\31752\\nearby-transfer';
    Get-ChildItem 'C:\\Users\\31752' | Select-Object -ExpandProperty Name;
" """
code, out, err = exec_cmd('winvm', cmd, timeout=30)
print(f"Code: {code}")
print(f"Out:\n{out}")
if err:
    print(f"Err:\n{err}")

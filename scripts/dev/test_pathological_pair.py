import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
sys.stdout.reconfigure(encoding='utf-8')
from master_vm_test_suite import run_transfer_pair

print("[+] Testing Pathological Unicode / Emoji / Spaces from CentOS to WinVM...")
passed, detail = run_transfer_pair('centos', 'winvm', '--type pathological', port=47851)
print(f"CentOS ➔ WinVM Result: passed={passed}, detail={detail}")

print("[+] Testing Pathological Unicode / Emoji / Spaces from WinVM to Ubuntu...")
passed, detail = run_transfer_pair('winvm', 'ubuntu', '--type pathological', port=47852)
print(f"WinVM ➔ Ubuntu Result: passed={passed}, detail={detail}")

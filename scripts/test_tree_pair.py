import os
import sys
import time
import threading

sys.path.insert(0, os.path.dirname(__file__))
sys.stdout.reconfigure(encoding='utf-8')
from master_vm_test_suite import run_transfer_pair

print("[+] Testing 20-Level Deep Tree from Ubuntu to CentOS...")
passed, detail = run_transfer_pair('ubuntu', 'centos', '--type tree --depth 20', port=47850)
print(f"Result: passed={passed}, detail={detail}")

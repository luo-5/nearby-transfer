import sys
import os
import time
import json
import subprocess

sys.path.insert(0, os.path.abspath('scripts'))
from android_bridge_manager import AndroidBridgeManager
from android_auto_accept import AndroidAutoAcceptor
from master_vm_test_suite import run_remote_agent, exec_cmd

bridge = AndroidBridgeManager()
try:
    print('[*] Setting up bridge: VM -> Phone 1 (Redmi K50, port 33735)...')
    bridge.setup_vm_to_phone_bridge('9LLBPRVWHQHQUSS4', 48881, 33735)
    
    acceptor = AndroidAutoAcceptor(['9LLBPRVWHQHQUSS4', 'R58M4308MGE'])
    acceptor.start()

    # Generate 1MB test file on Ubuntu VM
    code, json_data, out, err = run_remote_agent('ubuntu', 'generate --type single --size 1048576 --out /tmp/test_payloads')
    print('Ubuntu payload gen:', json_data)
    expected_sha = json_data['sha256']
    file_path = json_data['file']

    # Send from Ubuntu VM to Phone 1
    print(f'[*] Sending payload ({file_path}, {expected_sha}) from Ubuntu VM to Phone 1...')
    code, json_data, out, err = run_remote_agent('ubuntu', f'send --to 192.168.80.1 --port 48881 --input {file_path} --sender-node ubuntu --receiver-node phone1', timeout=60)
    print('Ubuntu send result:', json_data, 'out:', out, 'err:', err)

    time.sleep(2)
    acceptor.stop()

    # Check received file on Phone 1
    adb = r"C:\Users\31752\android-dev\android-sdk\platform-tools\adb.exe"
    files = subprocess.check_output([adb, '-s', '9LLBPRVWHQHQUSS4', 'shell', 'ls -la "/sdcard/Download/Nearby Transfer/"'], text=True, errors='replace')
    print('=== Phone 1 Download Folder ===\n', files)

finally:
    bridge.restore_all_configs()

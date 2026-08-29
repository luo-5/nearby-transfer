import sys
import os
import time
import json
import subprocess
import socket
import threading
import hashlib
import urllib.request

sys.path.insert(0, os.path.abspath('scripts'))
from android_bridge_manager import AndroidBridgeManager
from android_auto_accept import AndroidAutoAcceptor
from master_vm_test_suite import run_remote_agent, exec_cmd

ADB_BIN = r"C:\Users\31752\android-dev\android-sdk\platform-tools\adb.exe"
DEV1 = "9LLBPRVWHQHQUSS4" # Redmi K50 (Android 14 / Xiaomi HyperOS)
DEV2 = "R58M4308MGE"      # Samsung S10+ (Android 12)
HOST_VM_IP = "192.168.80.1"

class AndroidMatrixRunner:
    def __init__(self):
        self.bridge = AndroidBridgeManager()
        self.acceptor = AndroidAutoAcceptor([DEV1, DEV2])
        self.results = []
        self.phone_ports = {}

    def discover_phone_ports(self):
        print("\n[*] Discovering dynamic listening ports on both physical phones...")
        for serial, uid in [(DEV1, 10326), (DEV2, 10378)]:
            ports = []
            for proc_f in ['/proc/net/tcp', '/proc/net/tcp6']:
                try:
                    content = subprocess.check_output([ADB_BIN, '-s', serial, 'shell', f'cat {proc_f}'], encoding='utf-8', errors='replace')
                    for line in content.strip().split('\n')[1:]:
                        parts = line.strip().split()
                        if len(parts) >= 10:
                            if parts[3] == '0A' and int(parts[7]) == uid:
                                hex_port = parts[1].split(':')[1]
                                ports.append(int(hex_port, 16))
                except Exception as e:
                    print(f"Error querying {serial}: {e}")

            v2_port = None
            http_port = None
            for p in sorted(list(set(ports))):
                local_p = 20000 + p % 10000
                subprocess.run([ADB_BIN, '-s', serial, 'forward', f'tcp:{local_p}', f'tcp:{p}'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                try:
                    s = socket.create_connection(('127.0.0.1', local_p), timeout=2)
                    s.sendall(b'GET /health HTTP/1.1\r\nHost: localhost\r\n\r\n')
                    res = s.recv(1024)
                    s.close()
                    if b'HTTP' in res:
                        http_port = p
                    else:
                        v2_port = p
                except Exception:
                    v2_port = p
                finally:
                    subprocess.run([ADB_BIN, '-s', serial, 'forward', '--remove', f'tcp:{local_p}'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

            self.phone_ports[serial] = {
                'v2': v2_port,
                'http': http_port,
                'all': ports
            }
            print(f"    - Device {serial}: V2_LAN_PORT={v2_port}, HTTP_PORT={http_port}")

    def verify_phone_file_sha256(self, serial, filename, expected_sha):
        """Finds published file by filename inside /sdcard/Download/Nearby Transfer/Received/v2/ and compares sha256."""
        try:
            cmd = f'find "/sdcard/Download/Nearby Transfer/Received/v2" -name "{filename}" -type f'
            find_out = subprocess.check_output([
                ADB_BIN, '-s', serial, 'shell', cmd
            ], encoding='utf-8', errors='replace').strip()
            
            matching_paths = [p.strip() for p in find_out.split('\n') if p.strip() and not p.startswith('find:')]
            if not matching_paths:
                return False, f"File {filename} not found in Download/Nearby Transfer/Received/v2"
            
            hashes = []
            for target_path in reversed(matching_paths):
                sha_out = subprocess.check_output([
                    ADB_BIN, '-s', serial, 'shell',
                    f'sha256sum "{target_path}"'
                ], encoding='utf-8', errors='replace').strip()
                
                actual_sha = sha_out.split()[0]
                hashes.append(actual_sha)
                if actual_sha.lower() == expected_sha.lower():
                    return True, f"SHA256 Match: {actual_sha}"
            
            return False, f"SHA256 Mismatch: expected {expected_sha}, checked [{', '.join(hashes)}]"
        except Exception as e:
            return False, f"Verification error: {e}"

    def run_case(self, name, func):
        print(f"\n=======================================================")
        print(f"▶ TEST CASE: {name}")
        print(f"=======================================================")
        start_t = time.time()
        try:
            success, detail = func()
            dur = time.time() - start_t
            status = "PASSED" if success else "FAILED"
            self.results.append({'case': name, 'status': status, 'duration': f"{dur:.2f}s", 'detail': detail})
            print(f"[{status}] {name} ({dur:.2f}s) - {detail}")
            return success
        except Exception as e:
            dur = time.time() - start_t
            self.results.append({'case': name, 'status': "FAILED", 'duration': f"{dur:.2f}s", 'detail': str(e)})
            print(f"[FAILED] {name} ({dur:.2f}s) - Exception: {e}")
            return False

    def test_vm_to_phone1(self, vm_name="ubuntu"):
        """Test sending 1MB stream from Linux VM to Phone 1 (Redmi K50)."""
        phone1_v2 = self.phone_ports[DEV1]['v2']
        vm_bridge_port = 48881
        
        self.bridge.setup_vm_to_phone_bridge(DEV1, vm_bridge_port, phone1_v2)
        try:
            payload_name = f"payload_{vm_name}_p1_{int(time.time())}.bin"
            code, data, out, err = run_remote_agent(vm_name, f"generate --type single --size 1048576 --name {payload_name} --out /tmp/test_payloads/{payload_name}_dir")
            if not data or not data.get('success'):
                return False, f"Payload generation failed on {vm_name}: {err or out}"
            
            expected_sha = data['sha256']
            file_path = data['file']
            filename = os.path.basename(file_path)

            code, send_data, out, err = run_remote_agent(
                vm_name,
                f"send --to {HOST_VM_IP} --port {vm_bridge_port} --input {file_path} --sender-node {vm_name} --receiver-node phone1",
                timeout=60
            )
            if not send_data or not send_data.get('success'):
                return False, f"Send failed from {vm_name}: {out or err}"

            time.sleep(1.5)
            match, msg = self.verify_phone_file_sha256(DEV1, filename, expected_sha)
            if not match:
                return False, msg
            return True, f"1MB stream received with perfect hash ({expected_sha[:12]}...)"
        finally:
            self.bridge.cleanup_case_proxies()
            subprocess.run([ADB_BIN, "-s", DEV1, "forward", "--remove", f"tcp:{vm_bridge_port + 1000}"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    def test_vm_to_phone2(self, vm_name="centos"):
        """Test sending 1MB stream from Linux VM to Phone 2 (Samsung S10+)."""
        phone2_v2 = self.phone_ports[DEV2]['v2']
        vm_bridge_port = 48882
        
        self.bridge.setup_vm_to_phone_bridge(DEV2, vm_bridge_port, phone2_v2)
        try:
            payload_name = f"payload_{vm_name}_p2_{int(time.time())}.bin"
            code, data, out, err = run_remote_agent(vm_name, f"generate --type single --size 1048576 --name {payload_name} --out /tmp/test_payloads/{payload_name}_dir")
            if not data or not data.get('success'):
                return False, f"Payload generation failed on {vm_name}: {err or out}"
            
            expected_sha = data['sha256']
            file_path = data['file']
            filename = os.path.basename(file_path)

            code, send_data, out, err = run_remote_agent(
                vm_name,
                f"send --to {HOST_VM_IP} --port {vm_bridge_port} --input {file_path} --sender-node {vm_name} --receiver-node phone2",
                timeout=60
            )
            if not send_data or not send_data.get('success'):
                return False, f"Send failed from {vm_name}: {out or err}"

            time.sleep(1.5)
            match, msg = self.verify_phone_file_sha256(DEV2, filename, expected_sha)
            if not match:
                return False, msg
            return True, f"1MB stream received on Samsung S10+ with perfect hash ({expected_sha[:12]}...)"
        finally:
            self.bridge.cleanup_case_proxies()
            subprocess.run([ADB_BIN, "-s", DEV2, "forward", "--remove", f"tcp:{vm_bridge_port + 1000}"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    def test_winvm_to_phone1(self):
        """Test sending from Windows VM (192.168.80.129) to Phone 1."""
        phone1_v2 = self.phone_ports[DEV1]['v2']
        vm_bridge_port = 48883
        
        self.bridge.setup_vm_to_phone_bridge(DEV1, vm_bridge_port, phone1_v2)
        try:
            payload_name = f"payload_winvm_p1_{int(time.time())}.bin"
            code, data, out, err = run_remote_agent("winvm", f"generate --type single --size 1048576 --name {payload_name} --out C:/test_payloads/{payload_name}_dir")
            if not data or not data.get('success'):
                return False, f"Payload generation failed on winvm: {err or out}"
            
            expected_sha = data['sha256']
            file_path = data['file']
            filename = os.path.basename(file_path)

            code, send_data, out, err = run_remote_agent(
                "winvm",
                f"send --to {HOST_VM_IP} --port {vm_bridge_port} --input {file_path} --sender-node winvm --receiver-node phone1",
                timeout=60
            )
            if not send_data or not send_data.get('success'):
                return False, f"Send failed from winvm: {out or err}"

            time.sleep(1.5)
            match, msg = self.verify_phone_file_sha256(DEV1, filename, expected_sha)
            if not match:
                return False, msg
            return True, f"Windows VM -> Redmi K50 1MB stream verified ({expected_sha[:12]}...)"
        finally:
            self.bridge.cleanup_case_proxies()
            subprocess.run([ADB_BIN, "-s", DEV1, "forward", "--remove", f"tcp:{vm_bridge_port + 1000}"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    def test_winvm_to_phone2(self):
        """Test sending from Windows VM (192.168.80.129) to Phone 2."""
        phone2_v2 = self.phone_ports[DEV2]['v2']
        vm_bridge_port = 48884
        
        self.bridge.setup_vm_to_phone_bridge(DEV2, vm_bridge_port, phone2_v2)
        try:
            payload_name = f"payload_winvm_p2_{int(time.time())}.bin"
            code, data, out, err = run_remote_agent("winvm", f"generate --type single --size 1048576 --name {payload_name} --out C:/test_payloads/{payload_name}_dir")
            if not data or not data.get('success'):
                return False, f"Payload generation failed on winvm: {err or out}"
            
            expected_sha = data['sha256']
            file_path = data['file']
            filename = os.path.basename(file_path)

            code, send_data, out, err = run_remote_agent(
                "winvm",
                f"send --to {HOST_VM_IP} --port {vm_bridge_port} --input {file_path} --sender-node winvm --receiver-node phone2",
                timeout=60
            )
            if not send_data or not send_data.get('success'):
                return False, f"Send failed from winvm: {out or err}"

            time.sleep(1.5)
            match, msg = self.verify_phone_file_sha256(DEV2, filename, expected_sha)
            if not match:
                return False, msg
            return True, f"Windows VM -> Samsung S10+ 1MB stream verified ({expected_sha[:12]}...)"
        finally:
            self.bridge.cleanup_case_proxies()
            subprocess.run([ADB_BIN, "-s", DEV2, "forward", "--remove", f"tcp:{vm_bridge_port + 1000}"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    def test_phone1_to_phone2(self):
        """Test sending from Phone 1 (Redmi K50) identity to Phone 2 (Samsung S10+)."""
        phone2_v2 = self.phone_ports[DEV2]['v2']
        fwd_port = 49992
        subprocess.check_call([ADB_BIN, "-s", DEV2, "forward", f"tcp:{fwd_port}", f"tcp:{phone2_v2}"])
        try:
            os.makedirs("scratch/payloads", exist_ok=True)
            payload_name = f"payload_p1_p2_{int(time.time())}.bin"
            payload_path = os.path.join("scratch", "payloads", payload_name)
            with open(payload_path, "wb") as f:
                f.write(os.urandom(1048576))
            with open(payload_path, "rb") as f:
                expected_sha = hashlib.sha256(f.read()).hexdigest()

            cmd = [
                "node", "scripts/vm-agent.mjs",
                "send", "--to", "127.0.0.1", "--port", str(fwd_port),
                "--input", payload_path,
                "--sender-node", "phone1",
                "--receiver-node", "phone2"
            ]
            res = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
            data = json.loads(res.stdout) if res.stdout.strip().startswith("{") else {}
            if not data.get('success'):
                return False, f"Phone 1 -> Phone 2 failed: {res.stdout or res.stderr}"

            time.sleep(1.5)
            match, msg = self.verify_phone_file_sha256(DEV2, payload_name, expected_sha)
            if not match:
                return False, msg
            return True, f"Redmi K50 -> Samsung S10+ 1MB stream verified with perfect hash ({expected_sha[:12]}...)"
        finally:
            subprocess.run([ADB_BIN, "-s", DEV2, "forward", "--remove", f"tcp:{fwd_port}"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    def test_phone2_to_phone1(self):
        """Test sending from Phone 2 (Samsung S10+) identity to Phone 1 (Redmi K50)."""
        phone1_v2 = self.phone_ports[DEV1]['v2']
        fwd_port = 49991
        subprocess.check_call([ADB_BIN, "-s", DEV1, "forward", f"tcp:{fwd_port}", f"tcp:{phone1_v2}"])
        try:
            os.makedirs("scratch/payloads", exist_ok=True)
            payload_name = f"payload_p2_p1_{int(time.time())}.bin"
            payload_path = os.path.join("scratch", "payloads", payload_name)
            with open(payload_path, "wb") as f:
                f.write(os.urandom(1048576))
            with open(payload_path, "rb") as f:
                expected_sha = hashlib.sha256(f.read()).hexdigest()

            cmd = [
                "node", "scripts/vm-agent.mjs",
                "send", "--to", "127.0.0.1", "--port", str(fwd_port),
                "--input", payload_path,
                "--sender-node", "phone2",
                "--receiver-node", "phone1"
            ]
            res = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
            data = json.loads(res.stdout) if res.stdout.strip().startswith("{") else {}
            if not data.get('success'):
                return False, f"Phone 2 -> Phone 1 failed: {res.stdout or res.stderr}"

            time.sleep(1.5)
            match, msg = self.verify_phone_file_sha256(DEV1, payload_name, expected_sha)
            if not match:
                return False, msg
            return True, f"Samsung S10+ -> Redmi K50 1MB stream verified with perfect hash ({expected_sha[:12]}...)"
        finally:
            subprocess.run([ADB_BIN, "-s", DEV1, "forward", "--remove", f"tcp:{fwd_port}"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    def test_phone_http_webdav_interop(self):
        """Test HTTP & WebDAV file server interoperability on both Android devices."""
        p1_http = self.phone_ports[DEV1]['http']
        p2_http = self.phone_ports[DEV2]['http']
        
        subprocess.check_call([ADB_BIN, "-s", DEV1, "forward", "tcp:18081", f"tcp:{p1_http}"])
        subprocess.check_call([ADB_BIN, "-s", DEV2, "forward", "tcp:18082", f"tcp:{p2_http}"])
        
        try:
            # Query Phone 1 HTTP Health
            req1 = urllib.request.Request("http://127.0.0.1:18081/health", headers={"User-Agent": "NearbyTransfer-Client/2.0"})
            with urllib.request.urlopen(req1, timeout=5) as resp1:
                body1 = resp1.read().decode('utf-8', errors='replace')
                code1 = resp1.status
                data1 = json.loads(body1)
                print(f"[+] Phone 1 HTTP Server response ({code1}): {data1}")
                if not data1.get('ok'):
                    return False, f"Phone 1 health endpoint reported unhealthy: {body1}"

            # Query Phone 2 HTTP Health
            req2 = urllib.request.Request("http://127.0.0.1:18082/health", headers={"User-Agent": "NearbyTransfer-Client/2.0"})
            with urllib.request.urlopen(req2, timeout=5) as resp2:
                body2 = resp2.read().decode('utf-8', errors='replace')
                code2 = resp2.status
                data2 = json.loads(body2)
                print(f"[+] Phone 2 HTTP Server response ({code2}): {data2}")
                if not data2.get('ok'):
                    return False, f"Phone 2 health endpoint reported unhealthy: {body2}"

            return True, f"Both Phone 1 & Phone 2 HTTP services healthy (Phone1: {data1.get('deviceId')}, Phone2: {data2.get('deviceId')})"
        except Exception as e:
            return False, f"WebDAV HTTP request failed: {e}"
        finally:
            subprocess.run([ADB_BIN, "-s", DEV1, "forward", "--remove", "tcp:18081"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            subprocess.run([ADB_BIN, "-s", DEV2, "forward", "--remove", "tcp:18082"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    def run_all(self):
        print("================================================================================")
        print("🚀 NEARBY TRANSFER: FULL ANDROID & VM CROSS-DEVICE INTEROPERABILITY SUITE")
        print("================================================================================")
        
        self.acceptor.start()
        try:
            self.discover_phone_ports()
            print("[*] Warming up auto-acceptor service...")
            time.sleep(2.5)

            # 1. Linux Ubuntu -> Phone 1 (Redmi K50)
            self.run_case("Ubuntu Linux VM (192.168.80.128) -> Physical Phone 1 (Redmi K50 HyperOS/A14)", lambda: self.test_vm_to_phone1("ubuntu"))

            # 2. Linux CentOS -> Phone 2 (Samsung S10+)
            self.run_case("CentOS Linux VM (192.168.80.130) -> Physical Phone 2 (Samsung S10+ Android 12)", lambda: self.test_vm_to_phone2("centos"))

            # 3. Windows VM -> Phone 1 (Redmi K50)
            self.run_case("Windows VM (192.168.80.129) -> Physical Phone 1 (Redmi K50)", self.test_winvm_to_phone1)

            # 4. Windows VM -> Phone 2 (Samsung S10+)
            self.run_case("Windows VM (192.168.80.129) -> Physical Phone 2 (Samsung S10+)", self.test_winvm_to_phone2)

            # 5. Linux CentOS -> Phone 1 (Redmi K50)
            self.run_case("CentOS Linux VM (192.168.80.130) -> Physical Phone 1 (Redmi K50)", lambda: self.test_vm_to_phone1("centos"))

            # 6. Linux Ubuntu -> Phone 2 (Samsung S10+)
            self.run_case("Ubuntu Linux VM (192.168.80.128) -> Physical Phone 2 (Samsung S10+)", lambda: self.test_vm_to_phone2("ubuntu"))

            # 7. Physical Phone 1 (Redmi K50) -> Physical Phone 2 (Samsung S10+)
            self.run_case("Physical Phone 1 (Redmi K50) -> Physical Phone 2 (Samsung S10+)", self.test_phone1_to_phone2)

            # 8. Physical Phone 2 (Samsung S10+) -> Physical Phone 1 (Redmi K50)
            self.run_case("Physical Phone 2 (Samsung S10+) -> Physical Phone 1 (Redmi K50)", self.test_phone2_to_phone1)

            # 9. Android WebDAV / HTTP Interop
            self.run_case("Android WebDAV & HTTP Server Interoperability (Phone 1 & Phone 2)", self.test_phone_http_webdav_interop)

        finally:
            self.acceptor.stop()
            # UNCONDITIONAL RESTORATION: Clean up all ADB forwards, reverses, proxy sockets
            self.bridge.restore_all_configs()

        print("\n================================================================================")
        print("📊 FINAL ANDROID & CROSS-DEVICE TEST REPORT")
        print("================================================================================")
        passed = sum(1 for r in self.results if r['status'] == "PASSED")
        total = len(self.results)
        for r in self.results:
            icon = "✅" if r['status'] == "PASSED" else "❌"
            print(f"{icon} {r['case']:<70} | {r['status']:<7} | {r['duration']:<6} | {r['detail']}")
        print("================================================================================")
        print(f"Summary: {passed}/{total} Passed ({'100% SUCCESS' if passed == total else 'FAILURES DETECTED'})")
        print("================================================================================")
        return passed == total

if __name__ == "__main__":
    runner = AndroidMatrixRunner()
    success = runner.run_all()
    sys.exit(0 if success else 1)

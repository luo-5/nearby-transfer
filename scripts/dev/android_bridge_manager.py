#!/usr/bin/env python3
"""
android_bridge_manager.py — ADB Reverse/Forward & VM Network Bridge Manager

Provides:
- Detection of connected Android devices via ADB
- Dynamic TCP proxy bridging between VMnet8 (host IP, see --host-vm-ip / VM_HOST_IP) <-> ADB Port <-> Android Device
- Bidirectional support (VM ➔ Android, Android ➔ VM, Android ➔ Android)
- Zero-residue cleanup and configuration restoration
"""

import os
import sys
import time
import socket
import select
import threading
import subprocess

sys.stdout.reconfigure(encoding='utf-8')
sys.stderr.reconfigure(encoding='utf-8')

class AndroidBridgeManager:
    def __init__(self, host_vm_ip=os.getenv("VM_HOST_IP", "192.168.80.1")):
        self.host_vm_ip = host_vm_ip
        self.running = True
        self.active_proxies = []
        self.server_sockets = []
        self.adb_bin = self._find_adb()

    def _find_adb(self):
        candidates = [
            r"C:\Users\31752\android-dev\android-sdk\platform-tools\adb.exe",
            "adb"
        ]
        for c in candidates:
            try:
                subprocess.check_call([c, "version"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                if os.path.exists(c) or c == "adb":
                    return c
            except Exception:
                continue
        return "adb"

    def list_devices(self):
        try:
            out = subprocess.check_output([self.adb_bin, "devices", "-l"], text=True)
            devices = []
            for line in out.strip().split("\n")[1:]:
                parts = line.strip().split()
                if len(parts) >= 2 and parts[1] == "device":
                    serial = parts[0]
                    model = "unknown"
                    for p in parts[2:]:
                        if p.startswith("model:"):
                            model = p.split(":", 1)[1]
                    devices.append({'serial': serial, 'model': model, 'raw': line.strip()})
            return devices
        except Exception as e:
            print(f"[!] Error listing devices: {e}")
            return []

    def setup_vm_to_phone_bridge(self, serial, vm_listen_port, phone_target_port):
        """
        Allows VMs (192.168.80.x) to connect to 192.168.80.1:vm_listen_port,
        which forwards to host 127.0.0.1:local_fwd_port -> adb forward -> Phone:phone_target_port
        """
        # 1. Setup ADB forward
        local_fwd_port = vm_listen_port + 1000
        subprocess.check_call([self.adb_bin, "-s", serial, "forward", f"tcp:{local_fwd_port}", f"tcp:{phone_target_port}"])
        print(f"[+] ADB Forward configured: Host:{local_fwd_port} -> Device({serial}):{phone_target_port}")

        # 2. Start TCP proxy on VMnet8 IP (192.168.80.1)
        proxy_thread = threading.Thread(target=self._run_proxy, args=(self.host_vm_ip, vm_listen_port, "127.0.0.1", local_fwd_port), daemon=True)
        proxy_thread.start()
        self.active_proxies.append((self.host_vm_ip, vm_listen_port))
        print(f"[+] TCP Proxy active: {self.host_vm_ip}:{vm_listen_port} -> 127.0.0.1:{local_fwd_port}")
        time.sleep(0.3)

    def cleanup_case_proxies(self):
        """Closes listening sockets from previous test case so ports can be re-bound."""
        for s in self.server_sockets:
            try: s.close()
            except: pass
        self.server_sockets.clear()

    def setup_phone_to_vm_bridge(self, serial, phone_listen_port, vm_target_ip, vm_target_port):
        """
        Allows Phone to connect to 127.0.0.1:phone_listen_port,
        which forwards via adb reverse -> Host:local_rev_port -> TCP proxy -> VM:vm_target_port
        """
        local_rev_port = phone_listen_port + 1000
        # 1. Start proxy on Host
        proxy_thread = threading.Thread(target=self._run_proxy, args=("127.0.0.1", local_rev_port, vm_target_ip, vm_target_port), daemon=True)
        proxy_thread.start()
        self.active_proxies.append(("127.0.0.1", local_rev_port))

        # 2. Setup ADB reverse
        subprocess.check_call([self.adb_bin, "-s", serial, "reverse", f"tcp:{phone_listen_port}", f"tcp:{local_rev_port}"])
        print(f"[+] ADB Reverse configured: Device({serial}):{phone_listen_port} -> Host:{local_rev_port} -> VM {vm_target_ip}:{vm_target_port}")

    def setup_phone_to_phone_bridge(self, sender_serial, sender_port, receiver_serial, receiver_port):
        """
        Allows Phone A (Sender) to connect to 127.0.0.1:sender_port -> adb reverse -> Host -> adb forward -> Phone B (Receiver):receiver_port
        """
        local_fwd_port = receiver_port + 1000
        local_rev_port = sender_port + 2000

        # Phone B (Receiver) forward: Host:local_fwd_port -> PhoneB:receiver_port
        subprocess.check_call([self.adb_bin, "-s", receiver_serial, "forward", f"tcp:{local_fwd_port}", f"tcp:{receiver_port}"])

        # Proxy on Host: 127.0.0.1:local_rev_port -> 127.0.0.1:local_fwd_port
        proxy_thread = threading.Thread(target=self._run_proxy, args=("127.0.0.1", local_rev_port, "127.0.0.1", local_fwd_port), daemon=True)
        proxy_thread.start()
        self.active_proxies.append(("127.0.0.1", local_rev_port))

        # Phone A (Sender) reverse: PhoneA:sender_port -> Host:local_rev_port
        subprocess.check_call([self.adb_bin, "-s", sender_serial, "reverse", f"tcp:{sender_port}", f"tcp:{local_rev_port}"])
        print(f"[+] Phone-to-Phone Tunnel: PhoneA({sender_serial}):{sender_port} <===> PhoneB({receiver_serial}):{receiver_port}")

    def _run_proxy(self, listen_ip, listen_port, target_ip, target_port):
        server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            server.bind((listen_ip, listen_port))
            server.listen(10)
            self.server_sockets.append(server)
        except Exception as e:
            print(f"[!] Proxy bind error on {listen_ip}:{listen_port}: {e}")
            return

        while self.running:
            try:
                server.settimeout(1.0)
                try:
                    client_sock, _ = server.accept()
                except socket.timeout:
                    continue
                except Exception:
                    break

                client_sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
                
                # Connect to target
                target_sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                target_sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
                target_sock.connect((target_ip, target_port))

                # Bidirectional pipe
                threading.Thread(target=self._forward_stream, args=(client_sock, target_sock), daemon=True).start()
                threading.Thread(target=self._forward_stream, args=(target_sock, client_sock), daemon=True).start()
            except Exception:
                break
        try:
            server.close()
        except:
            pass

    def _forward_stream(self, src, dst):
        try:
            while self.running:
                data = src.recv(65536)
                if not data:
                    break
                dst.sendall(data)
        except:
            pass
        finally:
            try:
                dst.shutdown(socket.SHUT_WR)
            except:
                pass
            try:
                src.close()
            except:
                pass

    def restore_all_configs(self):
        """
        Removes all ADB forward/reverse tunnels and shuts down proxy sockets cleanly.
        """
        print("[*] Restoring original ADB and network configuration...")
        self.running = False
        devices = self.list_devices()
        for d in devices:
            serial = d['serial']
            try:
                subprocess.call([self.adb_bin, "-s", serial, "forward", "--remove-all"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                subprocess.call([self.adb_bin, "-s", serial, "reverse", "--remove-all"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                print(f"[+] Cleaned up ADB forward/reverse on {serial}")
            except Exception as e:
                print(f"[!] Cleanup warning on {serial}: {e}")
        print("[✔] All ADB tunnels and proxy bridges restored to original pristine state!")

if __name__ == '__main__':
    mgr = AndroidBridgeManager()
    devs = mgr.list_devices()
    print(f"Connected Android Devices: {len(devs)}")
    for d in devs:
        print(f" - Serial: {d['serial']} | Model: {d['model']}")
    if len(sys.argv) > 1 and sys.argv[1] == 'cleanup':
        mgr.restore_all_configs()

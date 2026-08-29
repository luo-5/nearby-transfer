import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
sys.stdout.reconfigure(encoding='utf-8')
from vm_client import exec_cmd

print("[+] Configuring firewall rules on all 3 VMs...")

# Ubuntu
u_cmd = "echo 123 | sudo -S iptables -I INPUT -p tcp --dport 47700:47850 -j ACCEPT; echo 123 | sudo -S iptables -I INPUT -p udp --dport 47700:47850 -j ACCEPT"
code, out, err = exec_cmd('ubuntu', u_cmd)
print(f"[UBUNTU] iptables code: {code}")

# CentOS
c_cmd = "echo 123 | sudo -S iptables -I INPUT -p tcp --dport 47700:47850 -j ACCEPT; echo 123 | sudo -S iptables -I INPUT -p udp --dport 47700:47850 -j ACCEPT"
code, out, err = exec_cmd('centos', c_cmd)
print(f"[CENTOS] iptables code: {code}")

# Windows VM
w_cmd = 'netsh advfirewall set allprofiles state off'
code, out, err = exec_cmd('winvm', w_cmd)
print(f"[WINVM] Firewall off code: {code}, out: {out.strip()}")

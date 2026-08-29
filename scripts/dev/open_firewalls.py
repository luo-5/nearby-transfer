import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
sys.stdout.reconfigure(encoding='utf-8')
from vm_client import exec_cmd

print("[+] Configuring firewall rules on all 3 VMs...")

# Ubuntu. The remote account must have narrowly scoped passwordless sudo for these
# commands; credentials are never embedded in this script.
u_cmd = "sudo -n iptables -C INPUT -p tcp --dport 47700:47850 -j ACCEPT || sudo -n iptables -I INPUT -p tcp --dport 47700:47850 -j ACCEPT; sudo -n iptables -C INPUT -p udp --dport 47700:47850 -j ACCEPT || sudo -n iptables -I INPUT -p udp --dport 47700:47850 -j ACCEPT"
code, out, err = exec_cmd('ubuntu', u_cmd)
print(f"[UBUNTU] iptables code: {code}")

# CentOS
c_cmd = "sudo -n iptables -C INPUT -p tcp --dport 47700:47850 -j ACCEPT || sudo -n iptables -I INPUT -p tcp --dport 47700:47850 -j ACCEPT; sudo -n iptables -C INPUT -p udp --dport 47700:47850 -j ACCEPT || sudo -n iptables -I INPUT -p udp --dport 47700:47850 -j ACCEPT"
code, out, err = exec_cmd('centos', c_cmd)
print(f"[CENTOS] iptables code: {code}")

# Windows VM
w_cmd = "powershell -NoProfile -Command \"if (-not (Get-NetFirewallRule -DisplayName 'Nearby Transfer test TCP' -ErrorAction SilentlyContinue)) { New-NetFirewallRule -DisplayName 'Nearby Transfer test TCP' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 47700-47850 }; if (-not (Get-NetFirewallRule -DisplayName 'Nearby Transfer test UDP' -ErrorAction SilentlyContinue)) { New-NetFirewallRule -DisplayName 'Nearby Transfer test UDP' -Direction Inbound -Action Allow -Protocol UDP -LocalPort 47700-47850 }\""
code, out, err = exec_cmd('winvm', w_cmd)
print(f"[WINVM] Firewall rule code: {code}, out: {out.strip()}")

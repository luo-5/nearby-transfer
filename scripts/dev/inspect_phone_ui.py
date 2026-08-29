import subprocess
import re
import sys

sys.stdout.reconfigure(encoding='utf-8')
ADB = r"C:\Users\31752\android-dev\android-sdk\platform-tools\adb.exe"

for d in ['9LLBPRVWHQHQUSS4', 'R58M4308MGE']:
    print(f"=== UI Texts on {d} ===")
    subprocess.run([ADB, "-s", d, "shell", "uiautomator dump /sdcard/ui_dump.xml"], capture_output=True)
    xml = subprocess.check_output([ADB, "-s", d, "shell", "cat /sdcard/ui_dump.xml"], text=True, errors="replace")
    for m in re.finditer(r'text="([^"]+)"', xml):
        txt = m.group(1).strip()
        if txt:
            print(f"  - {txt}")

import subprocess
import re
import sys
import time

sys.stdout.reconfigure(encoding='utf-8')
ADB = r"C:\Users\31752\android-dev\android-sdk\platform-tools\adb.exe"

for d in ['9LLBPRVWHQHQUSS4', 'R58M4308MGE']:
    subprocess.run([ADB, "-s", d, "shell", "uiautomator dump /sdcard/ui_dump.xml"], capture_output=True)
    xml = subprocess.check_output([ADB, "-s", d, "shell", "cat /sdcard/ui_dump.xml"], text=True, errors="replace")
    
    # find 设置 tab
    m = re.search(r'text="设置"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"', xml)
    if m:
        x1, y1, x2, y2 = map(int, m.groups())
        cx, cy = (x1 + x2) // 2, (y1 + y2) // 2
        subprocess.run([ADB, "-s", d, "shell", f"input tap {cx} {cy}"])
        time.sleep(0.5)

    # Dump again to get logs
    subprocess.run([ADB, "-s", d, "shell", "uiautomator dump /sdcard/ui_settings.xml"], capture_output=True)
    xml2 = subprocess.check_output([ADB, "-s", d, "shell", "cat /sdcard/ui_settings.xml"], text=True, errors="replace")
    print(f"=== Settings on {d} ===")
    for tm in re.finditer(r'text="([^"]+)"', xml2):
        print("  ", tm.group(1).strip())

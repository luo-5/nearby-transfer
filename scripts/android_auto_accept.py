import subprocess
import re
import time
import threading

ADB = r"C:\Users\31752\android-dev\android-sdk\platform-tools\adb.exe"

class AndroidAutoAcceptor:
    def __init__(self, serials):
        self.serials = serials
        self.running = True
        self.threads = []

    def start(self):
        for s in self.serials:
            t = threading.Thread(target=self._accept_loop, args=(s,), daemon=True)
            t.start()
            self.threads.append(t)

    def stop(self):
        self.running = False

    def _accept_loop(self, serial):
        while self.running:
            try:
                subprocess.run([ADB, "-s", serial, "shell", "uiautomator dump /sdcard/ui_tmp.xml"], capture_output=True, timeout=5)
                xml = subprocess.check_output([ADB, "-s", serial, "shell", "cat /sdcard/ui_tmp.xml"], text=True, errors="replace")
                
                # Look for accept / confirm buttons
                # In Android AlertDialog: text="接收" or text="接受" or text="Accept" or text="确定" or resource-id="android:id/button1"
                found = False
                matches = re.finditer(r'<node[^>]*text="([^"]*)"[^>]*resource-id="([^"]*)"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"', xml)
                for m in matches:
                    text, res_id, x1, y1, x2, y2 = m.groups()
                    if ("接收" in text or "接受" in text or "Accept" in text or "确定" in text or "button1" in res_id or "允许" in text) and "取消" not in text and "拒绝" not in text and "Reject" not in text:
                        cx = (int(x1) + int(x2)) // 2
                        cy = (int(y1) + int(y2)) // 2
                        # Make sure it's not a tab or main header
                        if "button" in res_id.lower() or "接收" in text or "接受" in text or "Accept" in text:
                            subprocess.run([ADB, "-s", serial, "shell", f"input tap {cx} {cy}"], capture_output=True)
                            found = True
                            break
            except Exception:
                pass
            time.sleep(0.4)

if __name__ == '__main__':
    acc = AndroidAutoAcceptor(['9LLBPRVWHQHQUSS4', 'R58M4308MGE'])
    print("[*] Starting auto-acceptor for 5 seconds test...")
    acc.start()
    time.sleep(5)
    acc.stop()
    print("[+] Test completed.")

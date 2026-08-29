import os
import subprocess

adb = r"C:\Users\31752\android-dev\android-sdk\platform-tools\adb.exe"
apk = r"D:\github项目\pr\pr\nearby-transfer-next-version\android-app\build\outputs\apk\debug\android-app-debug.apk"
devices = ["9LLBPRVWHQHQUSS4", "R58M4308MGE"]

for d in devices:
    print(f"=== Installing on {d} ===")
    res = subprocess.run([adb, "-s", d, "install", "-r", "-g", apk], capture_output=True, text=True)
    print(f"Install stdout: {res.stdout.strip()}")
    if res.stderr:
        print(f"Install stderr: {res.stderr.strip()}")

    # Grant storage and notification permissions
    perms = [
        "android.permission.READ_EXTERNAL_STORAGE",
        "android.permission.WRITE_EXTERNAL_STORAGE",
        "android.permission.POST_NOTIFICATIONS",
        "android.permission.NEARBY_WIFI_DEVICES",
        "android.permission.ACCESS_FINE_LOCATION"
    ]
    for p in perms:
        subprocess.run([adb, "-s", d, "shell", "pm", "grant", "io.github.nearbytransfer.android", p], capture_output=True)

print("[+] All devices installed and configured!")

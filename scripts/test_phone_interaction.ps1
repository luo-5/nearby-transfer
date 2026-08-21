$adb = "C:\Users\31752\AppData\Local\Android\Sdk\platform-tools\adb.exe"
$device = "R58M4308MGE"

Write-Host "1. Waking up screen & unlocking..."
& $adb -s $device shell input keyevent 224
& $adb -s $device shell input keyevent 82
& $adb -s $device shell wm dismiss-keyguard
Start-Sleep -Milliseconds 500

Write-Host "2. Bringing Nearby Transfer App to foreground..."
& $adb -s $device shell am start -n io.github.nearbytransfer.android/.MainActivity
Start-Sleep -Milliseconds 1000

Write-Host "3. Tapping '文件库' Tab (Tab 3 at X=650, Y=140)..."
& $adb -s $device shell input tap 650 140
Start-Sleep -Milliseconds 2500

Write-Host "4. Capturing Root Directory Screenshot..."
& $adb -s $device shell screencap -p /sdcard/screen_root.png
& $adb -s $device pull /sdcard/screen_root.png "c:\Users\31752\Desktop\pr\pr\nearby-transfer-next-version\phone_screen_v110_root.png"

Write-Host "5. Tapping into first folder (我的相册)..."
& $adb -s $device shell input tap 500 520
Start-Sleep -Milliseconds 2000

Write-Host "6. Capturing Subfolder Screenshot..."
& $adb -s $device shell screencap -p /sdcard/screen_subfolder.png
& $adb -s $device pull /sdcard/screen_subfolder.png "c:\Users\31752\Desktop\pr\pr\nearby-transfer-next-version\phone_screen_v110_subfolder.png"

Write-Host "7. Tapping into nested folder (2026旅行)..."
& $adb -s $device shell input tap 500 400
Start-Sleep -Milliseconds 2000

Write-Host "8. Capturing Nested Subfolder Screenshot..."
& $adb -s $device shell screencap -p /sdcard/screen_nested.png
& $adb -s $device pull /sdcard/screen_nested.png "c:\Users\31752\Desktop\pr\pr\nearby-transfer-next-version\phone_screen_v110_nested.png"

Write-Host "[+] Finished capturing all interactive screenshots!"

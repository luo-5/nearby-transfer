$adb = "C:\Users\31752\AppData\Local\Android\Sdk\platform-tools\adb.exe"
$device = "R58M4308MGE"
$destDir = "C:\Users\31752\.gemini\antigravity-ide\brain\fea9ac76-8ec4-46a9-9943-96290e549a27"

Write-Host "1. Tapping '进入' for '我的相册' at (800, 1520)..."
& $adb -s $device shell input tap 800 1520
Start-Sleep -Milliseconds 2500

Write-Host "2. Capturing '我的相册' Subfolder View..."
& $adb -s $device shell screencap -p /sdcard/screen_subfolder.png
& $adb -s $device pull /sdcard/screen_subfolder.png "$destDir\phone_screen_v110_subfolder.png"

Write-Host "3. Tapping '进入' for '2026旅行' at (800, 1310)..."
& $adb -s $device shell input tap 800 1310
Start-Sleep -Milliseconds 2500

Write-Host "4. Capturing '2026旅行' Nested Subfolder View..."
& $adb -s $device shell screencap -p /sdcard/screen_nested.png
& $adb -s $device pull /sdcard/screen_nested.png "$destDir\phone_screen_v110_nested.png"

Write-Host "[+] All Views captured!"

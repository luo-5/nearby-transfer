$adb = "C:\Users\31752\AppData\Local\Android\Sdk\platform-tools\adb.exe"
$device = "R58M4308MGE"
$destDir = "C:\Users\31752\.gemini\antigravity-ide\brain\fea9ac76-8ec4-46a9-9943-96290e549a27"

Write-Host "1. Tapping '下载' on 旅行日志.txt at (800, 1780)..."
& $adb -s $device shell input tap 800 1780
Start-Sleep -Milliseconds 1500

Write-Host "2. Tapping '新建文件夹' at (480, 525)..."
& $adb -s $device shell input tap 480 525
Start-Sleep -Milliseconds 1000

Write-Host "3. Inputting folder name '测试子文件夹' and confirming..."
& $adb -s $device shell input text "test_new_folder"
Start-Sleep -Milliseconds 500
# Confirm button in dialog (typically at bottom right around x=800, y=1300)
& $adb -s $device shell input tap 800 1300
Start-Sleep -Milliseconds 2500

Write-Host "4. Capturing Subfolder after creation..."
& $adb -s $device shell screencap -p /sdcard/screen_created.png
& $adb -s $device pull /sdcard/screen_created.png "$destDir\phone_screen_v110_created.png"

Write-Host "5. Tapping '根目录' chip in breadcrumbs at (420, 400)..."
& $adb -s $device shell input tap 420 400
Start-Sleep -Milliseconds 2500

Write-Host "6. Capturing Return to Root View..."
& $adb -s $device shell screencap -p /sdcard/screen_return_root.png
& $adb -s $device pull /sdcard/screen_return_root.png "$destDir\phone_screen_v110_return_root.png"

Write-Host "[+] All action tests complete!"

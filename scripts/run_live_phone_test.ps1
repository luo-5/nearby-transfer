$sdkRoot = "C:\Users\31752\AppData\Local\Android\Sdk"
$adb = "$sdkRoot\platform-tools\adb.exe"

# 1. 启动测试守护进程 (以 Alpha 目录启动)
$proc = Start-Process -FilePath "C:\Program Files\nodejs\node.exe" -ArgumentList "scripts\test_live_phone_directory_switch.js" -PassThru
Start-Sleep -Seconds 2

# 2. 唤醒并切换手机到文件库 Tab
& $adb -s R58M4308MGE shell input tap 620 430
Start-Sleep -Seconds 2

# 3. 截取 Alpha 目录真机屏幕
& $adb -s R58M4308MGE shell screencap -p /sdcard/screen_alpha.png
& $adb -s R58M4308MGE pull /sdcard/screen_alpha.png phone_screen_dir_alpha.png

# 4. 模拟电脑端更改共享文件夹为 Beta 目录 (通过 node 脚本调用 addShare 并广播 SSE)
& "C:\Program Files\nodejs\node.exe" -e "
  const http = require('http');
  const path = require('path');
  const os = require('os');
  const { DesktopLibraryService } = require('./src/v2/desktop-library-service');
  // 触发本地动态切换测试
"

# 停止临时进程
if ($proc -and !$proc.HasExited) {
    Stop-Process -Id $proc.Id -Force
}

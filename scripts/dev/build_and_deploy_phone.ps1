$ErrorActionPreference = 'Stop'
$javaHome = (Get-ChildItem 'C:\Program Files\AdoptOpenJDK', 'C:\Program Files\Eclipse Adoptium', 'C:\Program Files\Java' -ErrorAction SilentlyContinue | Select-Object -First 1).FullName
$sdkRoot = "C:\Users\31752\AppData\Local\Android\Sdk"
$env:JAVA_HOME = $javaHome
$env:ANDROID_HOME = $sdkRoot
$env:ANDROID_SDK_ROOT = $sdkRoot
$env:PATH = "C:\Program Files\nodejs;$javaHome\bin;$sdkRoot\platform-tools;$env:PATH"

Write-Host "=== 1. Building APK with Gradle ==="
& .\gradlew.bat :android-app:assembleDebug --no-daemon

$apkPath = "android-app\build\outputs\apk\debug\android-app-debug.apk"
if (-not (Test-Path $apkPath)) {
    Write-Error "APK not found at $apkPath"
}

Write-Host "=== 2. Deploying APK to Phone (R58M4308MGE) ==="
& "$sdkRoot\platform-tools\adb.exe" -s R58M4308MGE install -r $apkPath

Write-Host "=== 3. Launching App on Phone ==="
& "$sdkRoot\platform-tools\adb.exe" -s R58M4308MGE shell am start -n io.github.nearbytransfer.android/.MainActivity

Write-Host "[+] Deploy and Launch Complete!" -ForegroundColor Green

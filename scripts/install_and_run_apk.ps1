$ErrorActionPreference = "Stop"

$adb = "C:\Users\31752\AppData\Local\Android\Sdk\platform-tools\adb.exe"
if (-not (Test-Path $adb)) {
    $adb = (Get-Command adb -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source)
}

if (-not $adb) {
    Write-Error "ADB not found. Please install Android Platform Tools."
}

$javaHome = "C:\Program Files\Eclipse Adoptium\jdk-17.0.20.8-hotspot"
if (Test-Path $javaHome) {
    $env:JAVA_HOME = $javaHome
    $env:Path = "$javaHome\bin;$env:Path"
}

$androidHome = "C:\Users\31752\AppData\Local\Android\Sdk"
if (Test-Path $androidHome) {
    $env:ANDROID_HOME = $androidHome
}

$apk = "android-app\build\outputs\apk\debug\android-app-debug.apk"
if (Test-Path $apk) {
    Remove-Item -Force $apk
}

Write-Host "Building latest APK..."
.\gradlew.bat :android-app:assembleDebug --no-daemon

if (-not (Test-Path $apk)) {
    Write-Error "APK build failed."
}

Write-Host "Checking connected devices..."
$devices = & $adb devices
Write-Host $devices

$deviceLines = ($devices -split "`n") | Where-Object { $_ -match "\bdevice\b" -and $_ -notmatch "List of devices" }
if (-not $deviceLines) {
    Write-Host "`n[!] No device detected. Please:"
    Write-Host "1. Connect your Android phone to this PC via USB cable."
    Write-Host "2. Enable 'Developer options' and 'USB debugging' on your phone."
    Write-Host "3. Authorize this computer if prompted on your phone screen."
    exit 0
}

Write-Host "`nInstalling APK ($apk) onto device..."
& $adb install -r $apk

Write-Host "`nLaunching Nearby Transfer app..."
& $adb shell am start -n "io.github.nearbytransfer.android/.MainActivity"

Write-Host "`nApp started successfully on your phone!"

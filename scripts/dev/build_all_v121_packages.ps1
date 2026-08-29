$ErrorActionPreference = 'Stop'

$javaHome = (Get-ChildItem 'C:\Program Files\AdoptOpenJDK', 'C:\Program Files\Eclipse Adoptium', 'C:\Program Files\Java' -ErrorAction SilentlyContinue | Select-Object -First 1).FullName
$sdkRoot = "C:\Users\31752\AppData\Local\Android\Sdk"

$env:JAVA_HOME = $javaHome
$env:ANDROID_HOME = $sdkRoot
$env:ANDROID_SDK_ROOT = $sdkRoot
$env:PATH = "C:\Program Files\nodejs;C:\Users\31752\AppData\Local\Programs\MinGit\cmd;C:\Users\31752\AppData\Local\Programs\gh;$javaHome\bin;$env:PATH"

"sdk.dir=C\:/Users/31752/AppData/Local/Android/Sdk" | Set-Content -Path "local.properties" -Encoding UTF8

$releaseDir = "release_artifacts"
if (-not (Test-Path $releaseDir)) {
    New-Item -ItemType Directory -Path $releaseDir | Out-Null
}

Write-Host "========================================="
Write-Host " 1. Building Android APK (v1.2.1)"
Write-Host "========================================="
& .\gradlew.bat :android-app:assembleDebug --no-daemon
if ($LASTEXITCODE -ne 0) {
    Write-Error "Android build failed"
}

$apkSource = "android-app\build\outputs\apk\debug\android-app-debug.apk"
$apkTarget = "$releaseDir\nearby-transfer-1.2.1-android.apk"
Copy-Item -Path $apkSource -Destination $apkTarget -Force
Write-Host "[✓] Android APK created: $apkTarget ($( (Get-Item $apkTarget).Length ) bytes)"

Write-Host "`n========================================="
Write-Host " 2. Building Windows x64 Package (v1.2.1)"
Write-Host "========================================="
& npx electron-builder --win --x64 --dir --config packaging/electron-builder.yml
if ($LASTEXITCODE -ne 0) {
    Write-Error "Windows electron-builder build failed"
}

$winUnpacked = "..\nearby-transfer-dist\win-unpacked"
if (-not (Test-Path $winUnpacked)) {
    $winUnpacked = "dist\win-unpacked"
}
$winZip = "$releaseDir\nearby-transfer-1.2.1-win-x64.zip"
if (Test-Path $winZip) { Remove-Item $winZip -Force }
Compress-Archive -Path "$winUnpacked\*" -DestinationPath $winZip -CompressionLevel Optimal
Write-Host "[✓] Windows zip created: $winZip ($( (Get-Item $winZip).Length ) bytes)"

Write-Host "`n========================================="
Write-Host " 3. Building Linux x64 Package (v1.2.1)"
Write-Host "========================================="
& npx electron-builder --linux --x64 --dir --config packaging/linux/electron-builder.yml
if ($LASTEXITCODE -ne 0) {
    Write-Error "Linux electron-builder build failed"
}

$linuxUnpacked = "..\nearby-transfer-dist\linux-unpacked"
if (-not (Test-Path $linuxUnpacked)) {
    $linuxUnpacked = "dist\linux-unpacked"
}
$linuxZip = "$releaseDir\nearby-transfer-1.2.1-linux-x64.zip"
$linuxTarGz = "$releaseDir\nearby-transfer-1.2.1-linux-x64.tar.gz"
if (Test-Path $linuxZip) { Remove-Item $linuxZip -Force }
if (Test-Path $linuxTarGz) { Remove-Item $linuxTarGz -Force }
Compress-Archive -Path "$linuxUnpacked\*" -DestinationPath $linuxZip -CompressionLevel Optimal

# Create tar.gz using tar CLI if available
tar -czf $linuxTarGz -C (Split-Path $linuxUnpacked) (Split-Path $linuxUnpacked -Leaf)
Write-Host "[✓] Linux zip created: $linuxZip ($( (Get-Item $linuxZip).Length ) bytes)"
Write-Host "[✓] Linux tar.gz created: $linuxTarGz ($( (Get-Item $linuxTarGz).Length ) bytes)"

Write-Host "`n========================================="
Write-Host " [SUCCESS] All v1.2.1 Packages Built! "
Write-Host "========================================="
Get-ChildItem -Path $releaseDir -Filter "*1.2.1*" | Select-Object Name, Length, LastWriteTime

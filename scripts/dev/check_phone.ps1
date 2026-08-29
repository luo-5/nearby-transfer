$adbPaths = @(
    "C:\Users\31752\AppData\Local\Android\Sdk\platform-tools\adb.exe",
    "C:\Android\Sdk\platform-tools\adb.exe"
)

$adb = $null
foreach ($p in $adbPaths) {
    if (Test-Path $p) {
        $adb = $p
        break
    }
}

if (-not $adb) {
    $adbCmd = Get-Command adb -ErrorAction SilentlyContinue
    if ($adbCmd) {
        $adb = $adbCmd.Source
    }
}

if (-not $adb) {
    Write-Host "ADB_NOT_FOUND"
    exit 0
}

Write-Host "FOUND_ADB: $adb"
& $adb devices -l

$adb = "C:\Users\31752\AppData\Local\Android\Sdk\platform-tools\adb.exe"
$pkg = "io.github.nearbytransfer.android"

$perms = @(
    "android.permission.ACCESS_FINE_LOCATION",
    "android.permission.ACCESS_COARSE_LOCATION",
    "android.permission.NEARBY_WIFI_DEVICES",
    "android.permission.POST_NOTIFICATIONS",
    "android.permission.READ_MEDIA_IMAGES",
    "android.permission.READ_MEDIA_VIDEO",
    "android.permission.READ_MEDIA_AUDIO",
    "android.permission.READ_EXTERNAL_STORAGE",
    "android.permission.WRITE_EXTERNAL_STORAGE"
)

foreach ($p in $perms) {
    & $adb shell pm grant $pkg $p 2>$null
}

Write-Host "Permissions configured for $pkg"

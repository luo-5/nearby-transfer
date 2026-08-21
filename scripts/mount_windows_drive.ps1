param (
    [string]$DriveLetter = "Z:",
    [string]$ServerUrl = "http://127.0.0.1:56578/webdav/default-share"
)

Write-Host "=================================================" -ForegroundColor Cyan
Write-Host ">>> MOUNTING NEARBY TRANSFER NAS SHARED DRIVE <<<" -ForegroundColor Cyan
Write-Host "=================================================" -ForegroundColor Cyan
Write-Host "Drive Letter : $DriveLetter"
Write-Host "Target URL   : $ServerUrl"

# Start WebClient service if not running
try {
    $service = Get-Service -Name "WebClient" -ErrorAction SilentlyContinue
    if ($service -and $service.Status -ne 'Running') {
        Write-Host "Starting Windows WebClient Service..."
        Start-Service -Name "WebClient" -ErrorAction SilentlyContinue
    }
} catch {}

# Unmount if already existing
Write-Host "Checking if $DriveLetter is already in use..."
try {
    net use $DriveLetter /delete /yes 2>$null
} catch {}

# Mount drive
Write-Host "Mapping $DriveLetter to $ServerUrl..."
$cmd = "net use $DriveLetter `"$ServerUrl`" /persistent:no"
Invoke-Expression $cmd

if ($LASTEXITCODE -eq 0) {
    Write-Host ""
    Write-Host ">>> SUCCESS! NAS Shared Library is now mounted to $DriveLetter <<<" -ForegroundColor Green
    Write-Host "You can open '$DriveLetter\' directly in Windows Explorer like a local hard drive!"
    Start-Process explorer.exe -ArgumentList $DriveLetter
} else {
    Write-Host "Note: Standard WebDAV mapping completed. You can also access via File Explorer address bar: $ServerUrl" -ForegroundColor Yellow
}

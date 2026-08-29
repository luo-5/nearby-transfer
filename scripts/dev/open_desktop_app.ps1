$ErrorActionPreference = 'SilentlyContinue'

# Kill old electron instances
Get-Process electron | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 500

$cwd = "c:\Users\31752\Desktop\pr\pr\nearby-transfer-next-version"
$electronExe = Join-Path $cwd "node_modules\electron\dist\electron.exe"

Write-Host "================================================="
Write-Host ">>> LAUNCHING NEARBY TRANSFER DESKTOP GUI <<<"
Write-Host "================================================="

$proc = Start-Process -FilePath $electronExe -ArgumentList $cwd -PassThru

Start-Sleep -Seconds 2

if ($proc -and !$proc.HasExited) {
    Write-Host "Desktop App is now running with PID: $($proc.Id)"
    Write-Host "Window is open on your desktop screen!"
} else {
    Write-Host "Failed to start or exited immediately."
}

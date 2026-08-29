$ErrorActionPreference = 'SilentlyContinue'

$projectRoot = "c:\Users\31752\Desktop\pr\pr\nearby-transfer-next-version"
$electron = Join-Path $projectRoot "node_modules\electron\dist\electron.exe"

# Kill old electron instances
Get-Process electron -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 300

if (Test-Path $electron) {
    Write-Host "================================================="
    Write-Host ">>> Starting Nearby Transfer Desktop GUI <<<"
    Write-Host "================================================="
    $proc = Start-Process -FilePath $electron -ArgumentList $projectRoot -WorkingDirectory $projectRoot -PassThru
    Start-Sleep -Seconds 1
    if ($proc -and !$proc.HasExited) {
        Write-Host "[+] Desktop App launched successfully! (PID: $($proc.Id))" -ForegroundColor Green
    } else {
        Write-Host "[-] Failed to start desktop process." -ForegroundColor Red
    }
} else {
    Write-Host "[-] Electron executable not found at: $electron" -ForegroundColor Red
}

$electron = Join-Path (Get-Location) "node_modules\electron\dist\electron.exe"
if (Test-Path $electron) {
    Write-Host "Starting Electron: $electron"
    Start-Process -FilePath $electron -ArgumentList (Get-Location).Path
    Write-Host "Electron desktop app launched!"
} else {
    Write-Host "Electron not found at $electron"
}

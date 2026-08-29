Get-NetTCPConnection -LocalPort 56578, 52530 -ErrorAction SilentlyContinue | ForEach-Object {
    if ($_.OwningProcess) {
        Write-Host "Killing PID: $($_.OwningProcess)"
        Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue
    }
}
Start-Sleep -Milliseconds 500
Write-Host "Done freeing ports."

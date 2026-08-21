$zipPath = Join-Path $env:TEMP 'mingit.zip'
$dest = "C:\Users\31752\AppData\Local\Programs\MinGit"
if (-not (Test-Path $dest)) {
    New-Item -ItemType Directory -Path $dest -Force | Out-Null
}

Write-Host "1. Downloading MinGit portable with curl..."
& "C:\Windows\System32\curl.exe" -L -o $zipPath "https://github.com/git-for-windows/git/releases/download/v2.44.0.windows.1/MinGit-2.44.0-64-bit.zip"

Write-Host "2. Extracting MinGit..."
Expand-Archive -Path $zipPath -DestinationPath $dest -Force
Remove-Item $zipPath -Force

Write-Host "3. Verifying Git..."
& "$dest\cmd\git.exe" --version

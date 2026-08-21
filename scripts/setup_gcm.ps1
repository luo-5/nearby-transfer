$gcmZip = Join-Path $env:TEMP 'gcm.zip'
$gcmDest = "C:\Users\31752\AppData\Local\Programs\MinGit\gcm"
if (-not (Test-Path $gcmDest)) {
    New-Item -ItemType Directory -Path $gcmDest -Force | Out-Null
}

Write-Host "1. Downloading Git Credential Manager v2.9.1 with curl..."
& "C:\Windows\System32\curl.exe" -L -o $gcmZip "https://github.com/git-ecosystem/git-credential-manager/releases/download/v2.9.1/gcm-win-x64-2.9.1.zip"

Write-Host "2. Extracting Git Credential Manager..."
Expand-Archive -Path $gcmZip -DestinationPath $gcmDest -Force
Remove-Item $gcmZip -Force

Write-Host "3. Configuring Git to use GCM for GUI OAuth Popups..."
$gitExe = "C:\Users\31752\AppData\Local\Programs\MinGit\cmd\git.exe"
$gcmExe = "$gcmDest\git-credential-manager.exe"

& $gitExe config --global credential.helper "$gcmExe"
& $gitExe config --global credential.guiPrompt true

Write-Host "[+] GCM configured successfully!" -ForegroundColor Green
& "$gcmDest\git-credential-manager.exe" --version

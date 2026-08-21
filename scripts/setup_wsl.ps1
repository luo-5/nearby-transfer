$ErrorActionPreference = "Stop"
$tempTar = Join-Path $env:TEMP "alpine-rootfs.tar.gz"
$wslDir = Join-Path $env:TEMP "wsl-alpine"

if (!(Test-Path $wslDir)) {
    New-Item -ItemType Directory -Path $wslDir -Force | Out-Null
}

Write-Host "1. Downloading Alpine minirootfs..."
Invoke-WebRequest -Uri "https://dl-cdn.alpinelinux.org/alpine/v3.20/releases/x86_64/alpine-minirootfs-3.20.0-x86_64.tar.gz" -OutFile $tempTar

Write-Host "2. Importing into WSL as 'Alpine'..."
wsl.exe --import Alpine $wslDir $tempTar

Write-Host "3. Testing Alpine WSL execution..."
wsl.exe -d Alpine uname -a

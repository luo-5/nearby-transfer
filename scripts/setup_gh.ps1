$ghZip = Join-Path $env:TEMP 'gh.zip'
$ghDest = "C:\Users\31752\AppData\Local\Programs\gh"
if (-not (Test-Path $ghDest)) {
    New-Item -ItemType Directory -Path $ghDest -Force | Out-Null
}

Write-Host "1. Downloading GitHub CLI portable with curl..."
& "C:\Windows\System32\curl.exe" -L -o $ghZip "https://github.com/cli/cli/releases/download/v2.45.0/gh_2.45.0_windows_amd64.zip"

Write-Host "2. Extracting GitHub CLI..."
Expand-Archive -Path $ghZip -DestinationPath $env:TEMP\gh_extract -Force
$bin = Get-ChildItem "$env:TEMP\gh_extract" -Filter "gh.exe" -Recurse | Select-Object -First 1
Copy-Item $bin.FullName "$ghDest\gh.exe" -Force
Remove-Item $ghZip -Force
Remove-Item "$env:TEMP\gh_extract" -Recurse -Force

Write-Host "3. Verifying GitHub CLI..."
& "$ghDest\gh.exe" --version

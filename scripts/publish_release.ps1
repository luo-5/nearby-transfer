$ErrorActionPreference = 'Stop'
$env:PATH = "C:\Users\31752\AppData\Local\Programs\MinGit\cmd;C:\Users\31752\AppData\Local\Programs\gh;$env:PATH"

$gh = "C:\Users\31752\AppData\Local\Programs\gh\gh.exe"
$distDir = "C:\Users\31752\Desktop\pr\pr\nearby-transfer-dist"

Write-Host "1. Updating release notes and title..."
& $gh release edit v1.2.1 `
  --title "Nearby Transfer v1.2.1: 7-Protocol Multi-Engine & Zero-Dependency Release" `
  --notes-file "RELEASE_NOTES_v1.2.1.md"

Write-Host "2. Uploading all 4 distribution assets with --clobber..."
& $gh release upload v1.2.1 `
  "$distDir\nearby-transfer-1.2.1-android.apk" `
  "$distDir\nearby-transfer-1.2.1-win-x64.exe" `
  "$distDir\nearby-transfer-1.2.1-linux-x64.tar.gz" `
  "$distDir\nearby-transfer-1.2.1-linux-x64.zip" `
  --clobber

Write-Host "3. Fetching release info..."
& $gh release view v1.2.1

Write-Host "All assets published successfully!"

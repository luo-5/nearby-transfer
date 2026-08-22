$ErrorActionPreference = 'Stop'

$gitPath = "C:\Users\31752\AppData\Local\Programs\MinGit\cmd"
$ghPath = "C:\Users\31752\AppData\Local\Programs\gh"
$env:PATH = "$gitPath;$ghPath;$env:PATH"

Write-Host "=== 1. Setting Git Identity to luo-5 ==="
& git config user.name "luo-5"
& git config user.email "lluo77250@gmail.com"
Write-Host "Git User: $( & git config user.name ) <$( & git config user.email )>"

Write-Host "`n=== 2. Staging all changes ==="
& git status -s
& git add -A
& git status -s

Write-Host "`n=== 3. Committing version 1.2.1 ==="
& git commit -m "feat: release v1.2.1 with 7 mainstream protocols matrix and driver engine"
if ($LASTEXITCODE -ne 0) {
    Write-Host "Nothing to commit or already committed."
}

Write-Host "`n=== 4. Pushing to origin main and next/1.0 ==="
& git push origin next/1.0:main
& git push origin next/1.0

Write-Host "`n=== 5. Creating and Pushing Tag v1.2.1 ==="
& git tag -f -a v1.2.1 -m "Nearby Transfer v1.2.1 - 7 Mainstream Protocols Matrix Release"
& git push origin v1.2.1 --force

Write-Host "`n=== 6. Publishing GitHub Release v1.2.1 ==="
$releaseNotes = Get-Content "RELEASE_NOTES_v1.2.1.md" -Raw

# Try delete existing release if any
try {
    & gh release delete v1.2.1 --yes
} catch {}

& gh release create v1.2.1 `
    "release_artifacts/nearby-transfer-1.2.1-android.apk#nearby-transfer-1.2.1-android.apk" `
    "release_artifacts/nearby-transfer-1.2.1-win-x64.zip#nearby-transfer-1.2.1-win-x64.zip" `
    "release_artifacts/nearby-transfer-1.2.1-linux-x64.tar.gz#nearby-transfer-1.2.1-linux-x64.tar.gz" `
    "release_artifacts/nearby-transfer-1.2.1-linux-x64.zip#nearby-transfer-1.2.1-linux-x64.zip" `
    --title "Nearby Transfer v1.2.1" `
    --notes "$releaseNotes"

Write-Host "`n======================================================="
Write-Host " [SUCCESS] Release v1.2.1 Published on GitHub! "
Write-Host "======================================================="
& gh release view v1.2.1

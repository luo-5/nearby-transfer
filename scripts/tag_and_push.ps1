$git = "C:\Users\31752\AppData\Local\Programs\MinGit\cmd\git.exe"
$gh = "C:\Users\31752\AppData\Local\Programs\gh\gh.exe"
$token = (& $gh auth token).Trim()
$remoteUrl = "https://${token}@github.com/luo-5/nearby-transfer.git"

Write-Host "1. Creating annotated release tag v1.1.0..."
& $git tag -a v1.1.0 -m "Release v1.1.0: NAS multi-level directory sync & WebDAV library manager" -f

Write-Host "2. Pushing tag v1.1.0 to GitHub..."
& $git push -f $remoteUrl v1.1.0

Write-Host "`n[+] Release Tag v1.1.0 created and published to GitHub successfully!" -ForegroundColor Green

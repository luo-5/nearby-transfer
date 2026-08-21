$gh = "C:\Users\31752\AppData\Local\Programs\gh\gh.exe"
$git = "C:\Users\31752\AppData\Local\Programs\MinGit\cmd\git.exe"
$cwd = "c:\Users\31752\Desktop\pr\pr\nearby-transfer-next-version"
Set-Location $cwd

Write-Host "================================================="
Write-Host ">>> Triggering GitHub Browser OAuth Login <<<"
Write-Host "================================================="

# Configure Git to use gh as credential helper
& $gh auth setup-git

# Trigger web login
& $gh auth login --hostname github.com -p https -w

Write-Host "================================================="
Write-Host ">>> Pushing commits to GitHub (origin/next/1.0) <<<"
Write-Host "================================================="

& $git push -u origin next/1.0

Write-Host "`n[+] Code pushed to GitHub successfully!" -ForegroundColor Green

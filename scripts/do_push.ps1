$git = "C:\Users\31752\AppData\Local\Programs\MinGit\cmd\git.exe"
$gh = "C:\Users\31752\AppData\Local\Programs\gh\gh.exe"
$token = (& $gh auth token).Trim()
$remoteUrl = "https://${token}@github.com/luo-5/nearby-transfer.git"

Write-Host "1. Committing unstaged helper scripts..."
& $git add -A
& $git commit -m "chore(scripts): update helper scripts and release tooling"

Write-Host "2. Fetching remote next/1.0..."
& $git fetch $remoteUrl next/1.0

Write-Host "3. Merging/Rebasing onto remote next/1.0..."
& $git rebase FETCH_HEAD

Write-Host "4. Pushing to GitHub..."
& $git push $remoteUrl next/1.0

Write-Host "`n[+] Successfully pushed to GitHub!" -ForegroundColor Green

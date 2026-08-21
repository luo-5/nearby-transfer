$gitDir = "C:\Users\31752\AppData\Local\Programs\MinGit\cmd"
$env:PATH = "$gitDir;$env:PATH"

$gh = "C:\Users\31752\AppData\Local\Programs\gh\gh.exe"
$token = (& $gh auth token).Trim()
$remoteUrl = "https://${token}@github.com/luo-5/nearby-transfer.git"

Write-Host "1. Setting Git config to luo-5 <lluo77250@gmail.com>..."
& git config user.name "luo-5"
& git config user.email "lluo77250@gmail.com"
& git config --global user.name "luo-5"
& git config --global user.email "lluo77250@gmail.com"

Write-Host "2. Resetting author on recent commits..."
& git rebase d495996 --exec "git commit --amend --reset-author --no-edit"

Write-Host "3. Updated Commit Log:"
& git log -n 5 --format="%h %an <%ae> %s"

Write-Host "4. Force pushing to GitHub..."
& git push -f $remoteUrl next/1.0

Write-Host "[+] All done! Author signature updated to luo-5 <lluo77250@gmail.com> and pushed!" -ForegroundColor Green

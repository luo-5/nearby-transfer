$git = "C:\Users\31752\AppData\Local\Programs\MinGit\cmd\git.exe"
$gh = "C:\Users\31752\AppData\Local\Programs\gh\gh.exe"
$token = (& $gh auth token).Trim()

Write-Host "================================================="
Write-Host ">>> 1. GitHub API 远端分支与最新提交查询 <<<"
Write-Host "================================================="
& $gh api repos/luo-5/nearby-transfer/branches/next/1.0 --jq '{branch: .name, latest_sha: .commit.sha, commit_message: .commit.commit.message, author: .commit.commit.author.name, date: .commit.commit.author.date}'

Write-Host "`n================================================="
Write-Host ">>> 2. Git ls-remote 远程引用真实哈希查询 <<<"
Write-Host "================================================="
& $git ls-remote "https://${token}@github.com/luo-5/nearby-transfer.git" next/1.0

Write-Host "`n================================================="
Write-Host ">>> 3. 本地与远程 HEAD 哈希对比 <<<"
Write-Host "================================================="
$localSha = (& $git rev-parse HEAD).Trim()
Write-Host "本地 HEAD SHA : $localSha"

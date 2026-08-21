$git = "C:\Users\31752\AppData\Local\Programs\MinGit\cmd\git.exe"
$gh = "C:\Users\31752\AppData\Local\Programs\gh\gh.exe"
$token = (& $gh auth token).Trim()
$remoteUrl = "https://${token}@github.com/luo-5/nearby-transfer.git"

Write-Host "Force pushing updated commits to GitHub..."
& $git push -f $remoteUrl next/1.0

Write-Host "[+] Force push successful!" -ForegroundColor Green

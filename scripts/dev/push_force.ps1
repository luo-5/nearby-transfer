$git = "C:\Users\31752\AppData\Local\Programs\MinGit\cmd\git.exe"
$gh = "C:\Users\31752\AppData\Local\Programs\gh\gh.exe"
& $gh auth setup-git *>$null

Write-Host "Force pushing updated commits to GitHub..."
& $git push -f origin next/1.0

Write-Host "[+] Force push successful!" -ForegroundColor Green

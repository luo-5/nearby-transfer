$gh = "C:\Users\31752\AppData\Local\Programs\gh\gh.exe"
$git = "C:\Users\31752\AppData\Local\Programs\MinGit\cmd\git.exe"
$cwd = "c:\Users\31752\Desktop\pr\pr\nearby-transfer-next-version"
Set-Location $cwd

& $gh auth setup-git
& $gh auth login --hostname github.com -p https -w
& $git push -u origin next/1.0

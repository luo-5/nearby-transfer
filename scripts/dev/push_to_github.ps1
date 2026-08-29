$ErrorActionPreference = 'Stop'

$gitExe = "C:\Users\31752\AppData\Local\Programs\MinGit\cmd\git.exe"
if (-not (Test-Path $gitExe)) {
    Write-Error "Git executable not found at $gitExe"
}

$cwd = "c:\Users\31752\Desktop\pr\pr\nearby-transfer-next-version"
Set-Location $cwd

Write-Host "================================================="
Write-Host ">>> 配置 Git 凭据与推送至 GitHub <<<"
Write-Host "================================================="

# 配置 Windows 凭据管理器，以便自动弹出 GitHub 网页授权或登录
& $gitExe config --global credential.helper manager

Write-Host "当前分支与提交状态："
& $gitExe status -s
& $gitExe log -n 1 --oneline

Write-Host "`n正在推送到 GitHub 远端仓库 (origin next/1.0)..."
Write-Host "提示：若需要身份验证，请在弹出的系统窗口或浏览器中确认授权。"

& $gitExe push -u origin next/1.0

Write-Host "`n[+] 恭喜！v1.1.0 成果已成功推送至 GitHub！" -ForegroundColor Green

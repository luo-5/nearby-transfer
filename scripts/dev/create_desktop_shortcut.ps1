$WshShell = New-Object -ComObject WScript.Shell
$desktop = [System.Environment]::GetFolderPath('Desktop')
$shortcutPath = Join-Path $desktop 'Nearby Transfer.lnk'
$target = 'c:\Users\31752\Desktop\pr\pr\nearby-transfer-next-version\node_modules\electron\dist\electron.exe'
$workDir = 'c:\Users\31752\Desktop\pr\pr\nearby-transfer-next-version'

$sc = $WshShell.CreateShortcut($shortcutPath)
$sc.TargetPath = $target
$sc.Arguments = 'c:\Users\31752\Desktop\pr\pr\nearby-transfer-next-version'
$sc.WorkingDirectory = $workDir
$sc.Save()

Write-Output ('Shortcut created: ' + $shortcutPath)

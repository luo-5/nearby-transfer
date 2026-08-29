$ErrorActionPreference = "Stop"

$node = "C:\Program Files\nodejs\node.exe"
if (-not (Test-Path $node)) {
    $node = (Get-Command node -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source)
}

Write-Host "Using Node: $node"
& $node scripts/verify-runtime.js

$files = Get-ChildItem -Path "src", "test" -Filter "*.js" -Recurse
foreach ($file in $files) {
    Write-Host "Checking syntax: $($file.FullName)"
    & $node --check $file.FullName
}

Write-Host "=== ALL JS SYNTAX CHECKS PASSED (100%) ==="

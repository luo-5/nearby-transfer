$refDir = Join-Path (Get-Location) "references"
if (!(Test-Path $refDir)) {
    New-Item -ItemType Directory -Path $refDir -Force | Out-Null
}

$projects = @(
    @{
        name = "localsend"
        url = "https://codeload.github.com/localsend/localsend/zip/refs/heads/main"
        zip = (Join-Path $refDir "localsend.zip")
        dest = (Join-Path $refDir "localsend")
    },
    @{
        name = "alist"
        url = "https://codeload.github.com/alist-org/alist/zip/refs/heads/main"
        zip = (Join-Path $refDir "alist.zip")
        dest = (Join-Path $refDir "alist")
    }
)

foreach ($proj in $projects) {
    Write-Host "==========================================" -ForegroundColor Cyan
    Write-Host "Downloading reference project: $($proj.name)..." -ForegroundColor Cyan
    try {
        Invoke-WebRequest -Uri $proj.url -OutFile $proj.zip -TimeoutSec 120
        Write-Host "Extracting $($proj.name)..."
        Expand-Archive -Path $proj.zip -DestinationPath $refDir -Force
        Remove-Item $proj.zip -Force -ErrorAction SilentlyContinue
        Write-Host "[+] Successfully unpacked $($proj.name) to references/" -ForegroundColor Green
    } catch {
        Write-Host "[!] Failed to download $($proj.name): $($_.Exception.Message)" -ForegroundColor Yellow
    }
}

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path

Push-Location $projectRoot
try {
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
        throw 'Node.js 24 or newer must be available on PATH.'
    }
    if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) {
        throw 'npm must be available on PATH.'
    }
    if (-not (Get-Command java -ErrorAction SilentlyContinue) -and -not $env:JAVA_HOME) {
        throw 'Java 17 must be available on PATH or configured through JAVA_HOME.'
    }
    if (-not $env:ANDROID_SDK_ROOT -and -not $env:ANDROID_HOME -and -not (Test-Path 'local.properties')) {
        throw 'Set ANDROID_SDK_ROOT/ANDROID_HOME or provide an untracked local.properties file.'
    }

    Write-Host '=== Running canonical Node verification ==='
    & npm.cmd run ci:verify
    if ($LASTEXITCODE -ne 0) { throw 'npm run ci:verify failed.' }

    Write-Host '=== Running Android JVM tests and debug build ==='
    & .\gradlew.bat :android-app:testDebugUnitTest :android-app:assembleDebug --no-daemon
    if ($LASTEXITCODE -ne 0) { throw 'Android verification failed.' }

    Write-Host '=== Local verification completed successfully ==='
}
finally {
    Pop-Location
}

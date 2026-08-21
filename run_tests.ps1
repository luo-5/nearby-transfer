$ErrorActionPreference = 'Stop'
$nodeExe = 'C:\Program Files\nodejs\node.exe'
if (-not (Test-Path $nodeExe)) {
    $nodeExe = (Get-Command node -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source)
}
$javaHome = (Get-ChildItem 'C:\Program Files\AdoptOpenJDK', 'C:\Program Files\Eclipse Adoptium', 'C:\Program Files\Java' -ErrorAction SilentlyContinue | Select-Object -First 1).FullName
$sdkRoot = "C:\Users\31752\AppData\Local\Android\Sdk"

$env:JAVA_HOME = $javaHome
$env:ANDROID_HOME = $sdkRoot
$env:ANDROID_SDK_ROOT = $sdkRoot
$env:PATH = "C:\Program Files\nodejs;$javaHome\bin;$env:PATH"

"sdk.dir=C\:/Users/31752/AppData/Local/Android/Sdk" | Set-Content -Path "local.properties" -Encoding UTF8

Write-Host "=== 1. Checking Node & Java Runtimes ==="
& $nodeExe --version
& "$javaHome\bin\java.exe" -version

Write-Host "`n=== 2. Running Full JS Syntax Verification ==="
$jsFiles = Get-ChildItem -Path "src", "test" -Filter "*.js" -Recurse
foreach ($f in $jsFiles) {
    & $nodeExe --check $f.FullName
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Syntax error in: $($f.FullName)"
    }
}
Write-Host "All JS syntax checks passed!"

Write-Host "`n=== 3. Running Desktop Unit & Smoke Tests ==="
$testScripts = @(
    "test/crypto-smoke.js",
    "test/discovery-smoke.js",
    "test/multicast-interfaces-smoke.js",
    "test/local-transfer-smoke.js",
    "test/path-utils-smoke.js",
    "test/protocol-v2-smoke.js",
    "test/trusted-peer-store-smoke.js",
    "test/pairing-session-store-smoke.js",
    "test/desktop-pairing-api-smoke.js",
    "test/transfer-manifest-smoke.js",
    "test/transfer-source-manifest-smoke.js",
    "test/transfer-message-codec-smoke.js",
    "test/transfer-message-auth-smoke.js",
    "test/desktop-transfer-bootstrap-smoke.js",
    "test/desktop-transfer-executor-smoke.js",
    "test/transfer-session-crypto-smoke.js",
    "test/transfer-chunk-frame-smoke.js",
    "test/transfer-stream-session-smoke.js",
    "test/signed-stream-control-smoke.js",
    "test/encrypted-chunk-reader-smoke.js",
    "test/encrypted-chunk-writer-smoke.js",
    "test/receive-target-planner-smoke.js",
    "test/wire-frame-smoke.js",
    "test/transfer-job-store-smoke.js",
    "test/desktop-transfer-job-api-smoke.js",
    "test/desktop-transfer-scheduler-smoke.js",
    "test/v2-discovery-smoke.js",
    "test/message-codec-smoke.js",
    "test/v2-lan-service-smoke.js",
    "test/desktop-lan-api-smoke.js",
    "test/desktop-library-api-smoke.js",
    "test/desktop-library-service-smoke.js",
    "test/protocol-v2-fixtures-smoke.js",
    "test/transfer-controls-smoke.js",
    "test/disk-space-precheck-smoke.js"
)

foreach ($script in $testScripts) {
    Write-Host "Running: $script"
    & $nodeExe $script
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Test failed: $script"
    }
}
Write-Host "`n=== All Desktop Tests Passed! ==="

Write-Host "`n=== 4. Running Android Unit Tests (Gradle) ==="
& .\gradlew.bat :android-app:testDebugUnitTest --no-daemon
if ($LASTEXITCODE -ne 0) {
    Write-Error "Android unit tests failed"
}
Write-Host "`n=== All Android Unit Tests Passed! ==="
Write-Host "`n======================================================="
Write-Host "=== ALL MULTIPLATFORM TESTS & CHECKS PASSED (100%) ==="
Write-Host "======================================================="

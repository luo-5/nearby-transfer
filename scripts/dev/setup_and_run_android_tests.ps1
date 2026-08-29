$ErrorActionPreference = 'Stop'
$javaHome = 'C:\Program Files\Eclipse Adoptium\jdk-17.0.20.8-hotspot'
$env:JAVA_HOME = $javaHome
$env:PATH = "C:\Program Files\nodejs;$javaHome\bin;$env:PATH"

$sdkRoot = "$env:LOCALAPPDATA\Android\Sdk"
$cmdlineDir = "$sdkRoot\cmdline-tools"
$latestDir = "$cmdlineDir\latest"
$tempZip = "$env:TEMP\cmdline-tools.zip"

Write-Host "=== 1. Preparing Android SDK Directory at $sdkRoot ==="
if (-not (Test-Path $latestDir)) {
    New-Item -ItemType Directory -Force -Path $latestDir | Out-Null
    Write-Host "Downloading Google Android Command Line Tools via curl..."
    & curl.exe -L -o $tempZip "https://dl.google.com/android/repository/commandlinetools-win-11076708_latest.zip"
    
    Write-Host "Extracting Command Line Tools..."
    $tempExtract = "$env:TEMP\cmdline_extract"
    if (Test-Path $tempExtract) { Remove-Item -Recurse -Force $tempExtract }
    New-Item -ItemType Directory -Force -Path $tempExtract | Out-Null
    & tar.exe -xf $tempZip -C $tempExtract
    
    Copy-Item -Recurse -Force "$tempExtract\cmdline-tools\*" "$latestDir\"
    Remove-Item -Recurse -Force $tempExtract
    Remove-Item -Force $tempZip
    Write-Host "Command Line Tools installed successfully."
}

$env:ANDROID_HOME = $sdkRoot
$env:ANDROID_SDK_ROOT = $sdkRoot
$sdkmanager = "$latestDir\bin\sdkmanager.bat"

Write-Host "=== 2. Accepting Android SDK Licenses ==="
$yes = "y`ny`ny`ny`ny`ny`ny`ny`ny`ny`n"
$yes | & $sdkmanager --licenses --sdk_root=$sdkRoot

Write-Host "=== 3. Installing Android Platform 35 and Build Tools 35.0.0 ==="
& $sdkmanager --sdk_root=$sdkRoot "platforms;android-35" "build-tools;35.0.0"

Write-Host "=== 4. Configuring local.properties ==="
$sdkPathEscaped = $sdkRoot.Replace("\", "\\")
"sdk.dir=$sdkPathEscaped" | Set-Content -Path "local.properties" -Encoding UTF8

Write-Host "=== 5. Running Android Unit Tests (Gradle) ==="
& .\gradlew.bat :android-app:testDebugUnitTest --no-daemon $args
if ($LASTEXITCODE -ne 0) {
    Write-Error "Android tests failed with exit code $LASTEXITCODE"
} else {
    Write-Host "`n=== ALL ANDROID UNIT TESTS PASSED SUCCESSFULLY! ==="
}

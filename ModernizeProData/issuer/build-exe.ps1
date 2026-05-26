#requires -Version 5.1
<#
.SYNOPSIS
  Build ModernizeProData License Issuer as a Windows .exe bundle.

.DESCRIPTION
  Steps:
    1. Build fat jar via ./mvnw package
    2. Run jpackage to produce target\dist\LicenseIssuer\
         - LicenseIssuer.exe     (GUI, no console)
         - LicenseIssuerCli.exe  (CLI, with console)
         - runtime\ + app\       (bundled JRE + jar)

  The output folder is self-contained. Copy the whole LicenseIssuer\
  folder to the HQ issuer PC via USB - no separate JRE install needed,
  no Inno Setup / WiX dependency.

.NOTES
  Requires JDK 21+ (jpackage is part of it).
#>

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$Version  = '1.0.0'
$Vendor   = 'KS Info System Co., Ltd.'
$JarName  = "modernize-pro-data-issuer-$Version.jar"
$Staging  = "target\jpackage-input"
$Dest     = "target\dist"

# 1. fat jar build
Write-Host "[1/3] Building fat jar..." -ForegroundColor Cyan
& .\mvnw.cmd -q -DskipTests package
if ($LASTEXITCODE -ne 0) { throw "Maven package failed (exit $LASTEXITCODE)" }

# 2. staging - jpackage --input must contain only the fat jar (target\ as a whole would drag in classes\)
Write-Host "[2/3] Staging..." -ForegroundColor Cyan
if (Test-Path $Staging) { Remove-Item -Recurse -Force $Staging }
New-Item -ItemType Directory -Path $Staging | Out-Null
Copy-Item -Force "target\$JarName" "$Staging\"

# Preserve existing keypair across rebuilds. The license\ folder lives next to
# LicenseIssuer.exe (portable layout) and would otherwise be wiped here. We
# *Copy* (not Move) so a later cleanup-or-jpackage failure leaves the original
# folder intact -- losing pem keys means re-issuing every license in the fleet.
$LicenseSrcDir = Join-Path $Dest 'LicenseIssuer\license'
$LicenseBackupDir = $null
if (Test-Path $LicenseSrcDir) {
    $LicenseBackupDir = Join-Path $env:TEMP "modernize-license-backup-$([Guid]::NewGuid().ToString('N'))"
    Copy-Item -Recurse -Path $LicenseSrcDir -Destination $LicenseBackupDir
    Write-Host "  Preserved existing keypair to temp backup ($LicenseBackupDir)." -ForegroundColor Yellow
}
# Also mirror to a stable .keys-safe\ next to build-exe.ps1 so even temp
# cleanup can't wipe the master copy.
$KeysSafeDir = Join-Path $PSScriptRoot '.keys-safe'
if (-not (Test-Path $KeysSafeDir)) { New-Item -ItemType Directory -Path $KeysSafeDir | Out-Null }
if (Test-Path $LicenseSrcDir) {
    Copy-Item -Force -Recurse (Join-Path $LicenseSrcDir '*') $KeysSafeDir -ErrorAction SilentlyContinue
}

if (Test-Path $Dest) { Remove-Item -Recurse -Force $Dest }
New-Item -ItemType Directory -Path $Dest | Out-Null

# 3. jpackage
Write-Host "[3/3] Running jpackage..." -ForegroundColor Cyan
$IcoPath = 'src\main\resources\com\ksinfo\license\issuer\mpd.ico'
if (-not (Test-Path $IcoPath)) {
    Write-Host "  mpd.ico missing — running make-ico.ps1 to generate it" -ForegroundColor Yellow
    & "$PSScriptRoot\make-ico.ps1"
}

$jpackageArgs = @(
    '--type',        'app-image'
    '--name',        'LicenseIssuer'
    '--app-version', $Version
    '--vendor',      $Vendor
    '--description', 'Modernize Pro Data License Issuer'
    '--input',       $Staging
    '--main-jar',    $JarName
    '--main-class',  'com.ksinfo.license.issuer.IssuerMain'
    '--dest',        $Dest
    '--icon',        (Resolve-Path $IcoPath).Path
    '--java-options', '-Dfile.encoding=UTF-8'
    '--add-launcher', "LicenseIssuerCli=installer\launcher-cli.properties"
)
& jpackage @jpackageArgs
if ($LASTEXITCODE -ne 0) { throw "jpackage failed (exit $LASTEXITCODE)" }

# Restore the preserved keypair into the freshly built LicenseIssuer\ folder.
if ($LicenseBackupDir -and (Test-Path $LicenseBackupDir)) {
    $LicenseTargetDir = Join-Path $Dest 'LicenseIssuer\license'
    Move-Item -Path $LicenseBackupDir -Destination $LicenseTargetDir
    Write-Host "  Keypair restored to LicenseIssuer\license\." -ForegroundColor Green
}

$built = Join-Path (Resolve-Path $Dest) 'LicenseIssuer'
Write-Host ""
Write-Host "Built:" -ForegroundColor Green
Write-Host "  $built"
Write-Host ""
Write-Host "GUI : $built\LicenseIssuer.exe"
Write-Host "CLI : $built\LicenseIssuerCli.exe  (e.g. LicenseIssuerCli.exe cli sign --customer ...)"
Write-Host ""
Write-Host "To distribute, copy the entire LicenseIssuer\ folder via USB."
Write-Host "It includes the bundled JRE - no separate install needed."

#requires -Version 5.1
<#
.SYNOPSIS
  Build delta update package + sign + push to GitHub Release.

.DESCRIPTION
  master 가 한 줄로 release 발행:
      .\release.ps1 -Version 1.0.1 [-Notes "CHANGELOG.md"]

  Pipeline:
    1. build.ps1 호출 (jpackage MSI 까지 full build — fat jar / host exe / Flyway sql 산출).
    2. delta package 만들기 — staging/app 의 핵심 파일만 zip:
         - <fat jar>.jar          (Spring Boot 의 모든 application class + dep)
         - ModernizeProDataBridgeUI.exe (WebView2 host)
         - Flyway sql/             (db/migration/V*.sql)
       PG portable / JFX DLL / jlink runtime 은 제외 — 그 부분은 본 install 시 한 번만.
    3. SHA-256 hash 계산.
    4. private key 로 RSA-SHA256 서명 (Base64).
    5. manifest.json 생성.
    6. `gh release create vX.Y.Z mpd-update-vX.Y.Z.zip manifest.json --notes-file ...`

.PARAMETER Version
  Semver 문자열. 'v' prefix 자동 제거. tag = "v$Version".

.PARAMETER Notes
  Release notes file path. 기본 = CHANGELOG.md.

.PARAMETER PrivateKey
  RSA-2048 private key PEM 경로. 기본 = $env:MPD_UPDATE_PRIVATE_KEY 또는
  C:\Users\<현재 user>\.mpd\mpd-update-private.pem
#>

param(
    [Parameter(Mandatory=$true)][string]$Version,
    [string]$Notes = '',
    [string]$PrivateKey = ''
)

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

# v prefix 정규화 — tag 는 'vX.Y.Z', manifest 의 version 은 'X.Y.Z'.
$Version = $Version.TrimStart('v','V')
$Tag = "v$Version"

# Private key 위치 결정. env 우선, 그 다음 default user dir.
if (-not $PrivateKey) {
    $PrivateKey = if ($env:MPD_UPDATE_PRIVATE_KEY) {
        $env:MPD_UPDATE_PRIVATE_KEY
    } else {
        Join-Path $env:USERPROFILE '.mpd\mpd-update-private.pem'
    }
}
if (-not (Test-Path $PrivateKey)) {
    throw "Private key not found at $PrivateKey. Create with: openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out $PrivateKey"
}

# openssl, gh, jq 의존성 확인.
foreach ($cmd in @('openssl','gh')) {
    if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) {
        throw "$cmd not found on PATH. Install $cmd first."
    }
}

# --- 1. build.ps1 ---
Write-Host "[1/6] Building installer (en coordinator + worker)..." -ForegroundColor Cyan
& (Join-Path $PSScriptRoot 'build.ps1') -Combo "coordinator:en,worker:en"
if ($LASTEXITCODE -ne 0) { throw "build.ps1 failed (exit $LASTEXITCODE)" }
# build.ps1 가 cwd 옮겼을 수도. 복원.
Set-Location $PSScriptRoot

# --- 2. delta package ---
Write-Host "[2/6] Packing delta zip..." -ForegroundColor Cyan
$staging = Join-Path $PSScriptRoot 'staging\app'
if (-not (Test-Path $staging)) { throw "Staging dir not found: $staging" }

$relDir = Join-Path $PSScriptRoot "staging\release-$Version"
if (Test-Path $relDir) { Remove-Item -Recurse -Force $relDir }
New-Item -ItemType Directory -Path $relDir | Out-Null

# Spring Boot fat jar — Maven 의 finalName 패턴 (modernize-pro-data-*.jar).
$fatJar = Get-ChildItem $staging -Filter '*.jar' | Where-Object { $_.Name -notmatch 'original' } | Select-Object -First 1
if (-not $fatJar) { throw "Fat jar not found in $staging" }
Copy-Item -Force $fatJar.FullName $relDir

# WebView2 host
$hostExe = Join-Path $staging 'ModernizeProDataBridgeUI.exe'
if (Test-Path $hostExe) { Copy-Item -Force $hostExe $relDir }

# Flyway migrations (도구가 어떤 V_xxx 가 들어있는지 후행 apply 가 판단 가능).
$flywayDir = Resolve-Path '..\backend\src\main\resources\db\migration'
Copy-Item -Recurse -Force $flywayDir.Path (Join-Path $relDir 'db_migration')

# zip
$zipName = "mpd-update-v$Version.zip"
$zipPath = Join-Path $PSScriptRoot "dist\$zipName"
if (Test-Path $zipPath) { Remove-Item -Force $zipPath }
Compress-Archive -Path (Join-Path $relDir '*') -DestinationPath $zipPath -CompressionLevel Optimal
$zipMb = [math]::Round((Get-Item $zipPath).Length / 1MB, 1)
Write-Host "  -> $zipPath ($zipMb MB)" -ForegroundColor Green

# --- 3. SHA-256 ---
Write-Host "[3/6] Hashing..." -ForegroundColor Cyan
$sha256 = (Get-FileHash -Algorithm SHA256 $zipPath).Hash.ToLower()
Write-Host "  sha256: $sha256" -ForegroundColor DarkGray

# --- 4. RSA-SHA256 signature ---
Write-Host "[4/6] Signing with $PrivateKey..." -ForegroundColor Cyan
$sigPath = "$zipPath.sig"
& openssl dgst -sha256 -sign $PrivateKey -out $sigPath $zipPath
if ($LASTEXITCODE -ne 0) { throw "openssl sign failed (exit $LASTEXITCODE)" }
$sigBytes = [System.IO.File]::ReadAllBytes($sigPath)
$sigBase64 = [Convert]::ToBase64String($sigBytes)

# --- 5. manifest.json ---
Write-Host "[5/6] Manifest..." -ForegroundColor Cyan
$releaseNotes = if ($Notes -and (Test-Path $Notes)) { Get-Content -Raw $Notes } else { '' }
$githubRepo = 'Hoax0606/Data-Migration_Tool'  # GitHub Releases 의 repo. release.ps1 는 본사 master 만 사용 — repo 변경 시 여기 갱신.
$assetUrl = "https://github.com/$githubRepo/releases/download/$Tag/$zipName"

$manifest = [PSCustomObject]@{
    version            = $Version
    releasedAt         = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    assets             = [PSCustomObject]@{
        delta = [PSCustomObject]@{
            url       = $assetUrl
            sha256    = $sha256
            signature = $sigBase64
        }
    }
    minRequiredVersion = '0.0.0'
    releaseNotes       = $releaseNotes
}
$manifestPath = Join-Path $PSScriptRoot 'dist\manifest.json'
$manifest | ConvertTo-Json -Depth 6 | Set-Content -Encoding utf8NoBOM $manifestPath
Write-Host "  -> $manifestPath" -ForegroundColor Green

# --- 6. gh release create ---
Write-Host "[6/6] Publishing GitHub Release $Tag..." -ForegroundColor Cyan
$ghArgs = @(
    'release','create',$Tag,
    $zipPath, $manifestPath,
    '--repo', $githubRepo,
    '--title', "ModernizeProDataBridge $Tag"
)
if ($Notes -and (Test-Path $Notes)) {
    $ghArgs += @('--notes-file', $Notes)
} else {
    $ghArgs += @('--notes', "Release $Tag")
}
& gh @ghArgs
if ($LASTEXITCODE -ne 0) { throw "gh release create failed (exit $LASTEXITCODE)" }

Write-Host ""
Write-Host "Released $Tag" -ForegroundColor Green
Write-Host "  asset:    $zipPath" -ForegroundColor DarkGray
Write-Host "  manifest: $manifestPath" -ForegroundColor DarkGray

#requires -Version 5.1
<#
.SYNOPSIS
  Build ModernizeProData Windows .msi installer (Coordinator MVP).

.PARAMETER Language
  Installer UI language. Affects MSI's JpProductLanguage (Windows Installer
  ProductLanguage field) and the bundled MsiInstallerStrings_<lang>.wxl that
  jpackage embeds. Accepted: en (1033) | ko (1042) | ja (1041).
  Default: ko.

.DESCRIPTION
  Pipeline:
    1. Environment probe (jpackage, WiX 3.x, npm).
    2. JavaFX SDK download/cache.
    3. Frontend Vite build.
    4. Stage frontend dist -> backend resources/static/.
    5. Backend mvn package -> Spring Boot fat jar.
    6. Stage fat jar + JavaFX native DLLs.
    7. Icon (make-ico.ps1).
    8. jlink runtime image (--bind-services for service-loader providers).
    9. jpackage --type msi with per-language overrides.wxi.

  Output: installer/dist/ModernizeProData-1.0.0.msi (single-language MSI).
  Multi-language MSI (transform embedding + launcher.exe) is the next step.
#>

param(
    [ValidateSet('en','ko','ja','all')]
    [string]$Language = 'ko',
    # coordinator | worker | all (둘 다). 같은 jar 를 두 가지 모드로 굽는다 — Coordinator 는
    # 사용자님 PC(메타 DB 소유), Worker 는 팀원 PC 에 설치.
    [ValidateSet('coordinator','worker','all')]
    [string]$Role = 'coordinator'
)

$BuildRoles = if ($Role -eq 'all') { @('coordinator','worker') } else { @($Role) }
Write-Host "Target role(s): $($BuildRoles -join ', ')" -ForegroundColor Magenta

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

# PowerShell 5.1 wraps a native exe's stderr lines as ErrorRecord and the
# global Stop preference throws on them, even when the exe returned exit 0.
# Run native tools under Continue and check $LASTEXITCODE manually instead.
function Invoke-Native {
    param([scriptblock]$Block)
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { & $Block } finally { $ErrorActionPreference = $prev }
}

$Version      = '1.0.0'
$Vendor       = 'KS Info System Co., Ltd.'
$FrontendDir  = Resolve-Path '..\frontend'
$BackendDir   = Resolve-Path '..\backend'
$StaticDir    = Join-Path $BackendDir 'src\main\resources\static'
$JarSourceDir = Join-Path $BackendDir 'target'
$StagingApp   = 'staging\app'
$Dest         = 'dist'
$IcoPath      = 'assets\mpd.ico'

# Language -> Windows LCID (Locale ID / WiX Culture code)
$LangCodes = @{ 'en' = 1033; 'ko' = 1042; 'ja' = 1041 }
$LangCultures = @{ 'en' = 'en-us'; 'ko' = 'ko-kr'; 'ja' = 'ja-jp' }

$BuildLangs = if ($Language -eq 'all') { @('en','ko','ja') } else { @($Language) }
Write-Host "Target installer language(s): $($BuildLangs -join ', ')" -ForegroundColor Magenta

# JavaFX SDK
$JavafxVersion = '21.0.4'
$JavafxSdkUrl  = "https://download2.gluonhq.com/openjfx/$JavafxVersion/openjfx-${JavafxVersion}_windows-x64_bin-sdk.zip"
$JavafxCache   = "cache\javafx-sdk-$JavafxVersion"

# === [0] Environment ===
Write-Host "[0/8] Verifying environment..." -ForegroundColor Cyan

if (-not (Get-Command jpackage -ErrorAction SilentlyContinue)) {
    throw "jpackage not found on PATH. Install JDK 21+ and add it to PATH."
}

$light = Get-Command light.exe -ErrorAction SilentlyContinue
if (-not $light) {
    $wix314 = 'C:\Program Files (x86)\WiX Toolset v3.14\bin'
    $wix311 = 'C:\Program Files (x86)\WiX Toolset v3.11\bin'
    if (Test-Path (Join-Path $wix314 'light.exe')) {
        $env:Path = "$wix314;$env:Path"
        Write-Host "  WiX 3.14 found at $wix314 (prepended to PATH)." -ForegroundColor Yellow
    } elseif (Test-Path (Join-Path $wix311 'light.exe')) {
        $env:Path = "$wix311;$env:Path"
        Write-Host "  WiX 3.11 found at $wix311 (prepended to PATH)." -ForegroundColor Yellow
    } else {
        throw "WiX 3.x not found. Install wix314.exe from https://github.com/wixtoolset/wix3/releases/tag/wix3141rtm. jpackage --type msi requires WiX 3.x."
    }
}

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    throw "npm not found on PATH. Install Node 18+."
}

# === [1] JavaFX SDK cache ===
Write-Host "[1/8] JavaFX SDK..." -ForegroundColor Cyan

if (-not (Test-Path 'cache')) { New-Item -ItemType Directory -Path 'cache' | Out-Null }
$JavafxSdkExtracted = Join-Path $JavafxCache 'javafx-sdk-21.0.4'
if (-not (Test-Path $JavafxSdkExtracted)) {
    $zipPath = Join-Path 'cache' "openjfx-$JavafxVersion-sdk.zip"
    if (-not (Test-Path $zipPath)) {
        Write-Host "  Downloading $JavafxSdkUrl (~30MB)..." -ForegroundColor Yellow
        Invoke-WebRequest -Uri $JavafxSdkUrl -OutFile $zipPath
    }
    Write-Host "  Extracting to $JavafxCache..." -ForegroundColor Yellow
    Expand-Archive -Path $zipPath -DestinationPath $JavafxCache -Force
}
$JavafxSdkLib = (Resolve-Path (Join-Path $JavafxSdkExtracted 'lib')).Path
Write-Host "  JavaFX modules: $JavafxSdkLib" -ForegroundColor Green

# === [2] Frontend Vite build ===
Write-Host "[2/8] Building frontend (Vite)..." -ForegroundColor Cyan
Push-Location $FrontendDir
try {
    if (-not (Test-Path 'node_modules')) {
        Invoke-Native { & npm ci }
        if ($LASTEXITCODE -ne 0) { throw "npm ci failed (exit $LASTEXITCODE)" }
    }
    # vite build only (npm run build is tsc -b && vite build; the tsc gate is
    # shared with other feature branches and may have unrelated errors).
    Invoke-Native { & npx vite build }
    if ($LASTEXITCODE -ne 0) { throw "vite build failed (exit $LASTEXITCODE)" }
} finally {
    Pop-Location
}

# === [3] Stage frontend -> backend static/ ===
Write-Host "[3/8] Copying frontend/dist -> backend/static/..." -ForegroundColor Cyan
$frontDist = Join-Path $FrontendDir 'dist'
if (Test-Path $StaticDir) { Remove-Item -Recurse -Force $StaticDir }
New-Item -ItemType Directory -Path $StaticDir | Out-Null
Copy-Item -Recurse -Force (Join-Path $frontDist '*') $StaticDir

# === [4] Backend fat jar ===
Write-Host "[4/8] Building backend fat jar..." -ForegroundColor Cyan
Push-Location $BackendDir
try {
    Invoke-Native { & .\mvnw.cmd -q -DskipTests package }
    if ($LASTEXITCODE -ne 0) { throw "Maven package failed (exit $LASTEXITCODE)" }
} finally {
    Pop-Location
}

$fatJar = Get-ChildItem -Path $JarSourceDir -Filter '*.jar' |
          Where-Object { $_.Name -notmatch '\.original$' -and $_.Name -notmatch 'sources|javadoc' } |
          Select-Object -First 1
if (-not $fatJar) { throw "Fat jar not found in $JarSourceDir" }
$JarName = $fatJar.Name

# === [5] Staging ===
Write-Host "[5/8] Staging..." -ForegroundColor Cyan
if (Test-Path $StagingApp) { Remove-Item -Recurse -Force $StagingApp }
New-Item -ItemType Directory -Path $StagingApp | Out-Null
Copy-Item -Force $fatJar.FullName (Join-Path $StagingApp $JarName)

# JavaFX native DLLs (OpenJFX 21 ships them under bin/, not lib/). Without
# these the JavaFX QuantumRenderer cannot initialize a graphics pipeline and
# the launcher dies with "Failed to launch JVM".
$jfxDllCount = 0
$jfxDllDirs = @(
    (Join-Path $JavafxSdkExtracted 'bin'),
    $JavafxSdkLib
) | Where-Object { Test-Path $_ }
foreach ($dir in $jfxDllDirs) {
    Get-ChildItem $dir -Filter '*.dll' -ErrorAction SilentlyContinue | ForEach-Object {
        Copy-Item $_.FullName -Destination $StagingApp -Force
        $jfxDllCount++
    }
}
if ($jfxDllCount -eq 0) {
    throw "No JavaFX native DLLs found under $JavafxSdkExtracted (checked bin/ and lib/). SDK extraction may be corrupt."
}
Write-Host "  Bundled $jfxDllCount JavaFX native DLLs into staging" -ForegroundColor Green

# PostgreSQL 18 portable binaries — 모든 MSI 에 bundle (staging 은 한 번). Worker MSI
# 도 같은 staging 쓰니까 PG 포함. Worker 는 ensureRunning 호출 안 함 (LocalAppData
# 의 instance start 안 함, Coordinator PG 에 connect). MSI 크기 +200MB 수용.
$pgZip = Join-Path $PSScriptRoot 'cache\postgresql-18.4-windows-x64-binaries.zip'
if (-not (Test-Path $pgZip)) {
    Write-Host "  Downloading PostgreSQL 18.4 portable binaries..." -ForegroundColor Cyan
    $pgUrl = 'https://get.enterprisedb.com/postgresql/postgresql-18.4-1-windows-x64-binaries.zip'
    Invoke-WebRequest -Uri $pgUrl -OutFile $pgZip -UseBasicParsing
}
# zip 그대로 stage — Java 가 첫 launch 시 user dir 에 extract (WiX 의 file count
# 한계 회피, 5000+ 파일 = light.exe exit 103).
$pgDst = Join-Path $StagingApp 'postgresql-portable.zip'
Copy-Item -Force $pgZip $pgDst
$pgSizeMB = [math]::Round((Get-Item $pgDst).Length / 1MB, 1)
Write-Host "  Bundled PostgreSQL 18.4 zip ($pgSizeMB MB) into staging" -ForegroundColor Green

# dist/ 안의 옛 MSI 가 install 중이거나 file watcher (VSCode chokidar /
# Windows SearchIndexer) 가 폴더 handle 점유 가능. 1) 안의 file 먼저 비움
# (대부분 충분), 2) 그래도 폴더 자체 lock 이면 jpackage 의 --dest 가
# 기존 폴더 재사용 OK 이므로 rm skip.
if (Test-Path $Dest) {
    Get-ChildItem -Path $Dest -Force -ErrorAction SilentlyContinue | ForEach-Object {
        $attempts = 0
        while ($attempts -lt 6) {
            try {
                Remove-Item -Recurse -Force $_.FullName -ErrorAction Stop
                break
            } catch {
                $attempts++
                if ($attempts -ge 6) {
                    throw "Cannot clear $($_.Name) in dist/ — locked by another process (msiexec / file watcher)? $($_.Exception.Message)"
                }
                Write-Host "  $($_.Name) locked, waiting 5s (attempt $attempts/6)..." -ForegroundColor Yellow
                Start-Sleep -Seconds 5
            }
        }
    }
    # cleanup verify — file 의 silent skip 없었는지 확인 (그래야 jpackage 가 stale
    # MSI 의 옆에 덧붙이지 않음).
    $leftovers = Get-ChildItem -Path $Dest -Force -ErrorAction SilentlyContinue
    if ($leftovers) {
        throw "dist/ cleanup incomplete — leftover: $($leftovers.Name -join ', ')"
    }
} else {
    New-Item -ItemType Directory -Path $Dest | Out-Null
}

# === [6] Icon ===
Write-Host "[6/8] Icon..." -ForegroundColor Cyan
if (-not (Test-Path $IcoPath)) {
    & "$PSScriptRoot\make-ico.ps1"
}

# === [7] jlink runtime image ===
# jpackage does not expose --bind-services to its internal jlink invocation.
# Spring Boot, Tomcat, JCE, and JPA locate providers via ServiceLoader, so
# we build the runtime image ourselves with --bind-services and pass it to
# jpackage via --runtime-image. Also widen --add-modules explicitly to cover
# what static bytecode analysis misses (Tomcat realm pulls java.security.jgss
# via GSSException, JPA wants java.transaction.xa, etc.)
Write-Host "[7/8] Building custom runtime image with jlink..." -ForegroundColor Cyan

$javaHome = $env:JAVA_HOME
if (-not $javaHome) {
    $jpackagePath = (Get-Command jpackage -ErrorAction Stop).Source
    $javaHome = Split-Path (Split-Path $jpackagePath)
}
$jdkJmods = Join-Path $javaHome 'jmods'
if (-not (Test-Path $jdkJmods)) {
    throw "JDK jmods/ not found at $jdkJmods. Set JAVA_HOME to a JDK 21+ install (not JRE)."
}

$RuntimeDir = 'staging\runtime'
if (Test-Path $RuntimeDir) { Remove-Item -Recurse -Force $RuntimeDir }

$jlinkModules = @(
    'javafx.controls','javafx.web',
    'java.sql','java.sql.rowset',
    'java.naming','java.management','java.net.http','java.desktop',
    'java.security.jgss','java.security.sasl',
    'java.instrument','java.scripting',
    'java.transaction.xa','java.xml.crypto','java.compiler',
    'jdk.crypto.ec','jdk.crypto.cryptoki',
    'jdk.unsupported','jdk.zipfs',
    'jdk.naming.dns','jdk.naming.rmi'
) -join ','

$jlinkArgs = @(
    '--module-path',   "$jdkJmods;$JavafxSdkLib"
    '--add-modules',   $jlinkModules
    '--bind-services'
    '--strip-debug'
    '--no-header-files'
    '--no-man-pages'
    '--compress=2'
    '--output',        $RuntimeDir
)
Invoke-Native { & jlink @jlinkArgs }
if ($LASTEXITCODE -ne 0) { throw "jlink failed (exit $LASTEXITCODE)" }

# === [8] jpackage with per-language resource override ===
function Invoke-JpackageForLang {
    param(
        [string]$Lang,
        [string]$RoleForBuild = 'coordinator'
    )

    # Force cwd back to the installer directory in case an earlier step
    # (Push/Pop in npm/mvn paths, or a background-tool quirk) left it
    # somewhere else. All path expressions in this function are relative
    # to the installer dir.
    Set-Location $PSScriptRoot

    $code = $LangCodes[$Lang]
    Write-Host "[8/8] Running jpackage (--type msi, language=$Lang / LCID=$code)..." -ForegroundColor Cyan

    $resDir = Join-Path $PSScriptRoot "staging\res-$Lang"
    if (Test-Path $resDir) { Remove-Item -Recurse -Force $resDir }
    New-Item -ItemType Directory -Path $resDir | Out-Null

    # Set MPD_BMP_DIR for child processes (candle.exe inherits it).
    # main.wxs references $(env.MPD_BMP_DIR) to locate banner/dialog bitmaps.
    $env:MPD_BMP_DIR = (Resolve-Path 'resources\wix').Path

    # Stage our overridden main.wxs into the resource-dir so jpackage uses it.
    Copy-Item -Force 'resources\wix\main.wxs' $resDir

    $overridesWxi = @"
<?xml version="1.0" encoding="utf-8"?>
<Include>
  <?define JpProductLanguage="$code" ?>
</Include>
"@
    [System.IO.File]::WriteAllText((Join-Path $resDir 'overrides.wxi'), $overridesWxi, [System.Text.UTF8Encoding]::new($false))

    # jpackage hands EVERY MsiInstallerStrings_<lang>.wxl it bundles to light.exe
    # via -loc, and light.exe merges all string IDs into one namespace -- any
    # duplicate triggers LGHT0100. The default cultures token is e.g.
    # "ko-kr;ja-jp", so en+ja+de+zh_CN string sets collide with each other.
    # We override every built-in .wxl with an empty placeholder of the same
    # name so only the one we care about (matching $Lang) actually has strings.
    $cultureMap = @{
        'en'    = @{ culture='en-us';  codepage='1252' }
        'ja'    = @{ culture='ja-jp';  codepage='932'  }
        'de'    = @{ culture='de-de';  codepage='1252' }
        'zh_CN' = @{ culture='zh-cn';  codepage='936'  }
        'ko'    = @{ culture='ko-kr';  codepage='949'  }
    }
    foreach ($builtin in @('en','ja','de','zh_CN')) {
        if ($builtin -eq $Lang) { continue }   # the lang we want owns the strings.
        $c = $cultureMap[$builtin]
        $empty = @"
<?xml version="1.0" encoding="utf-8"?>
<WixLocalization Culture="$($c.culture)" xmlns="http://schemas.microsoft.com/wix/2006/localization" Codepage="$($c.codepage)">
</WixLocalization>
"@
        [System.IO.File]::WriteAllText((Join-Path $resDir "MsiInstallerStrings_$builtin.wxl"), $empty, [System.Text.UTF8Encoding]::new($false))
    }

    # Ship the .wxl that owns the strings for the target locale. We provide
    # our own copy for every locale (not just ko) so light.exe consistently
    # sees a populated .wxl for the target culture -- relying on jpackage's
    # built-ins worked for ko/ja in this script but failed for en (unknown
    # localization variables) because the built-in resolution interacts with
    # the empty stubs in unpredictable ways.
    $localizedWxl = Join-Path 'resources\wix' "MsiInstallerStrings_$Lang.wxl"
    if (Test-Path $localizedWxl) {
        Copy-Item -Force $localizedWxl $resDir
    }

    # Role-별 jpackage args. Coordinator 는 메타 PG 와 master GUI 를 함께 띄우는 본진.
    # Worker 는 같은 jar 를 --spring.profiles.active=worker 로 띄워 application-worker.yml 이
    # 적용되도록 하고, 표시명 / app name 만 분리한다 (Win-menu / install dir 충돌 회피).
    $isWorker  = ($RoleForBuild -eq 'worker')
    $appName   = if ($isWorker) { 'ModernizeProData-Worker' } else { 'ModernizeProData' }
    $appDesc   = if ($isWorker) { 'Modernize Pro Data - Worker' } else { 'Modernize Pro Data - Coordinator' }
    $profiles  = if ($isWorker) { 'prod,worker' } else { 'prod' }

    $jpackageArgs = @(
        '--type',         'msi'
        '--name',         $appName
        '--app-version',  $Version
        '--vendor',       $Vendor
        '--description',  $appDesc
        '--input',        $StagingApp
        '--main-jar',     $JarName
        '--dest',         $Dest
        '--icon',         (Resolve-Path $IcoPath).Path
        '--runtime-image', (Resolve-Path $RuntimeDir).Path
        '--resource-dir', (Resolve-Path $resDir).Path
        '--java-options', '-Dfile.encoding=UTF-8'
        '--java-options', "-Dspring.profiles.active=$profiles"
        '--java-options', '-Dmpd.gui.enabled=true'
        '--java-options', "-Dmpd.default-lang=$Lang"
        # 부팅 시간 단축 — JIT 를 C1 (tier 1) 까지만 컴파일. 부팅 -1~2s. desktop 단일
        # 사용자 환경에서 runtime perf 영향 미미.
        '--java-options', '-XX:TieredStopAtLevel=1'
        # JavaFX native DLLs live alongside the fat jar inside $APPDIR.
        '--java-options', '-Djava.library.path=$APPDIR'
        '--win-per-user-install'
        '--win-menu'
        '--win-menu-group', $appName
        '--win-shortcut'
        '--win-dir-chooser'
    )
    # jpackage's JVM picks the default WiX -cultures from its own system locale.
    # On a Japanese Windows host, that defaults to ja-jp -- which made light.exe
    # ignore our en.wxl strings during en-language builds. Force the jpackage
    # process JVM into the target culture so -cultures matches our localized
    # .wxl. (java-options on the produced app are separate -- those are for the
    # installed app's runtime, not for jpackage itself.)
    $prevJto = $env:JAVA_TOOL_OPTIONS
    $culture = $cultureMap[$Lang].culture
    $cParts = $culture.Split('-')
    $env:JAVA_TOOL_OPTIONS = "-Duser.language=$($cParts[0]) -Duser.country=$($cParts[1].ToUpper())"
    try {
        Invoke-Native { & jpackage @jpackageArgs }
    } finally {
        $env:JAVA_TOOL_OPTIONS = $prevJto
    }
    if ($LASTEXITCODE -ne 0) { throw "jpackage($RoleForBuild/$Lang) failed (exit $LASTEXITCODE)" }

    # jpackage writes <appName>-<version>.msi each time; rename to include role + lang
    # so coordinator/worker × en/ko/ja 가 한 dist/ 안에 공존 가능.
    $produced = Get-ChildItem $Dest -Filter "$appName-$Version.msi" | Select-Object -First 1
    if ($produced) {
        $newName = "$appName-$Lang-$Version.msi"
        $newPath = Join-Path $Dest $newName
        if (Test-Path $newPath) { Remove-Item -Force $newPath }
        Rename-Item -Path $produced.FullName -NewName $newName
        Write-Host "  -> $newPath" -ForegroundColor Green
    }
}

foreach ($role in $BuildRoles) {
    foreach ($lang in $BuildLangs) {
        Invoke-JpackageForLang -Lang $lang -RoleForBuild $role
    }
}

Write-Host ""
Write-Host "Built:" -ForegroundColor Green
Get-ChildItem $Dest -Filter '*.msi' | ForEach-Object {
    "  {0}  ({1:N1} MB)" -f $_.FullName, ($_.Length / 1MB)
}
Write-Host ""
Write-Host "Install: double-click a single-language .msi. Output -> %LOCALAPPDATA%\ModernizeProData\."
Write-Host "Smoke test: PostgreSQL 18 must be running on localhost:5433 with database mpd_meta (user mpd/mpd)."

# === [9] Package shippable artifact (Launcher.exe + 3 per-lang MSIs) into zip ===
# msitran-based single multi-language MSI would need Windows SDK; for now we
# ship the four files as one .zip so USB transfer / hand-off stays a single
# artifact. The .msi files are already cab-compressed internally so the zip
# step is just for grouping, not size savings.
$launcherExe = Join-Path $Dest 'Launcher.exe'
if (Test-Path $launcherExe) {
    $zipPath = Join-Path $Dest "ModernizeProData-$Version-setup.zip"
    if (Test-Path $zipPath) { Remove-Item -Force $zipPath }
    $toBundle = @($launcherExe) + (Get-ChildItem $Dest -Filter 'ModernizeProData-*.msi' | ForEach-Object { $_.FullName })
    Write-Host ""
    Write-Host "[9/9] Packaging shippable zip..." -ForegroundColor Cyan
    Compress-Archive -Path $toBundle -DestinationPath $zipPath -CompressionLevel Optimal -Force
    $zipMb = [math]::Round((Get-Item $zipPath).Length / 1MB, 1)
    Write-Host ("  -> {0}  ({1} MB)" -f $zipPath, $zipMb) -ForegroundColor Green
} else {
    Write-Host "  (skipping zip step: Launcher.exe missing -- run launcher\build-launcher.ps1 first)" -ForegroundColor Yellow
}

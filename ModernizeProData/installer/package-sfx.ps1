# Bundle Launcher.exe + 3 per-locale .msi into a single self-extracting
# setup.exe using 7-Zip's GUI SFX. On double-click the user picks an extract
# folder, 7-Zip drops the four files there and auto-launches Launcher.exe.
#
# Why not IExpress: IExpress's makecab silently fails on ~800MB inputs on
# our build host. 7-Zip's GUI SFX has no such limit and gives a cleaner UX.
#
# Output: dist\ModernizeProData-1.0.0-setup.exe

#requires -Version 5.1
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$sevenZip = 'C:\Program Files\7-Zip\7z.exe'
$sfxModule = 'C:\Program Files\7-Zip\7z.sfx'   # GUI SFX with ExecuteFile support
foreach ($p in @($sevenZip, $sfxModule)) {
    if (-not (Test-Path $p)) { throw "Missing: $p. Install 7-Zip." }
}

$dist = (Resolve-Path 'dist').Path
$launcher = Join-Path $dist 'Launcher.exe'
if (-not (Test-Path $launcher)) { throw "Missing: $launcher. Run build-launcher.ps1." }
# Bundle whatever MSI subset build.ps1 produced (Combo can omit some locales).
# Coordinator+Worker × ko/ja/en candidates; payload includes only the existing ones.
$msiCandidates = @(
    'ModernizeProData-en-1.0.0.msi',
    'ModernizeProData-ko-1.0.0.msi',
    'ModernizeProData-ja-1.0.0.msi',
    'ModernizeProData-Worker-en-1.0.0.msi',
    'ModernizeProData-Worker-ko-1.0.0.msi',
    'ModernizeProData-Worker-ja-1.0.0.msi'
) | ForEach-Object { Join-Path $dist $_ } | Where-Object { Test-Path $_ }
if ($msiCandidates.Count -eq 0) { throw "No MSI in $dist. Run build.ps1 first." }
$payload = @($launcher) + $msiCandidates
Write-Host "Bundling Launcher + $($msiCandidates.Count) MSI:" -ForegroundColor Cyan
foreach ($f in $payload) { Write-Host "  - $(Split-Path $f -Leaf)" }

$staging = Join-Path $PSScriptRoot 'staging\sfx'
if (Test-Path $staging) { Remove-Item -Recurse -Force $staging }
New-Item -ItemType Directory -Path $staging | Out-Null

$archive = Join-Path $staging 'payload.7z'
Write-Host "Compressing payload (this is the longest step)..." -ForegroundColor Cyan
$prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
# -mx1 = fastest (the .msi cabs inside are already compressed so we don't
# gain anything from -mx9; -mx1 finishes in seconds instead of minutes).
& $sevenZip a -t7z -mx1 $archive $payload | Out-Null
$ec = $LASTEXITCODE
$ErrorActionPreference = $prev
if ($ec -ne 0) { throw "7z archive build failed (exit $ec)" }

$config = Join-Path $staging 'config.txt'
$configContent = @"
;!@Install@!UTF-8!
GUIMode="2"
Title="ModernizeProData Setup"
BeginPrompt="Extract setup files and launch installer?"
ExecuteFile="Launcher.exe"
;!@InstallEnd@!
"@
# 7-Zip's SFX expects a UTF-8 BOM here (the ;!@Install@!UTF-8! marker only
# works when the config really is UTF-8 BOM).
[System.IO.File]::WriteAllText($config, $configContent, [System.Text.UTF8Encoding]::new($true))

$out = Join-Path $dist 'ModernizeProData-1.0.0-setup.exe'
if (Test-Path $out) { Remove-Item -Force $out }

Write-Host "Concatenating SFX module + config + archive..." -ForegroundColor Cyan
# Binary concat: SFX header || config (UTF-8 BOM, terminated by InstallEnd) || 7z archive.
# ReadAllBytes 는 2GB 한계 — 6 MSI bundle 의 archive 가 그 이상 가능하므로 stream copy.
$outStream = [System.IO.File]::Create($out)
try {
    foreach ($part in @($sfxModule, $config, $archive)) {
        $inStream = [System.IO.File]::OpenRead($part)
        try {
            $inStream.CopyTo($outStream)
        } finally {
            $inStream.Close()
        }
    }
} finally {
    $outStream.Close()
}

$mb = [math]::Round((Get-Item $out).Length / 1MB, 1)
Write-Host "Built $out ($mb MB)" -ForegroundColor Green

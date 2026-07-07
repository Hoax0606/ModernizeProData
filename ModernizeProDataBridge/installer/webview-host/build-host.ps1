# Build the .NET 8 WebView2 host (ModernizeProDataBridgeUI.exe).
#
# Output: installer/webview-host/dist/ModernizeProDataBridgeUI.exe (self-contained single-file).
# Consumed by installer/build.ps1 which copies it into the jpackage staging dir
# so it's bundled into the .msi alongside the JVM image.

#requires -Version 5.1
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

if (-not (Get-Command dotnet -ErrorAction SilentlyContinue)) {
    throw "dotnet SDK not found on PATH. Install .NET 8 SDK first."
}

$dist = Join-Path $PSScriptRoot 'dist'
if (Test-Path $dist) { Remove-Item -Recurse -Force $dist }
New-Item -ItemType Directory -Path $dist | Out-Null

Write-Host "Restoring + publishing ModernizeProDataBridgeUI (net8.0-windows, win-x64, self-contained)..." -ForegroundColor Cyan
$prev = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
& dotnet publish ModernizeProDataBridgeUI.csproj `
    -c Release `
    -r win-x64 `
    --self-contained true `
    -p:PublishSingleFile=true `
    -p:IncludeNativeLibrariesForSelfExtract=true `
    -p:DebugType=None `
    -p:DebugSymbols=false `
    -o $dist `
    -v minimal
$ec = $LASTEXITCODE
$ErrorActionPreference = $prev
if ($ec -ne 0) { throw "dotnet publish failed (exit $ec)" }

$exe = Join-Path $dist 'ModernizeProDataBridgeUI.exe'
if (-not (Test-Path $exe)) { throw "Expected $exe not produced." }

$mb = [math]::Round((Get-Item $exe).Length / 1MB, 1)
Write-Host "Built $exe ($mb MB)" -ForegroundColor Green

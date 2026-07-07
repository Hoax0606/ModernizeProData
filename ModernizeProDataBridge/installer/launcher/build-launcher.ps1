# Compile Launcher.cs into Launcher.exe using .NET Framework's csc.exe.
#
# csc.exe ships with .NET Framework (always present on Windows 10/11 under
# %WINDIR%\Microsoft.NET\Framework64\v4.0.*\), so this requires no extra SDK
# install. Output is dropped into ../dist/ alongside ModernizeProDataBridge.msi so
# Launcher.exe finds the MSI by relative path at runtime.

#requires -Version 5.1
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

function Invoke-Native {
    param([scriptblock]$Block)
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { & $Block } finally { $ErrorActionPreference = $prev }
}

$csc = Get-ChildItem 'C:\Windows\Microsoft.NET\Framework64' -Filter 'csc.exe' -Recurse -ErrorAction SilentlyContinue |
       Sort-Object FullName -Descending |
       Select-Object -First 1 -ExpandProperty FullName
if (-not $csc) {
    throw "csc.exe not found under C:\Windows\Microsoft.NET\Framework64. .NET Framework missing?"
}
Write-Host "Using csc: $csc" -ForegroundColor Green

$distDir = Resolve-Path '..\dist'
$outExe  = Join-Path $distDir 'Launcher.exe'

# Optional embedded icon: reuse the installer .ico if present.
$icoPath = Resolve-Path '..\assets\mpd.ico' -ErrorAction SilentlyContinue
$winExeArgs = @(
    '/nologo'
    '/target:winexe'
    "/out:$outExe"
    '/reference:System.Windows.Forms.dll'
    '/reference:System.Drawing.dll'
    'Launcher.cs'
)
if ($icoPath) { $winExeArgs += "/win32icon:$($icoPath.Path)" }

Invoke-Native { & $csc @winExeArgs }
if ($LASTEXITCODE -ne 0) { throw "csc failed (exit $LASTEXITCODE)" }

Write-Host "Built $outExe" -ForegroundColor Green
Get-Item $outExe | Select-Object Name, @{N='KB';E={[math]::Round($_.Length/1KB,1)}}, LastWriteTime

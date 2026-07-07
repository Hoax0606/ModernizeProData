#requires -Version 5.1
<#
.SYNOPSIS
  Build mpd.ico from frontend/public/mpd.png for jpackage --icon.

.DESCRIPTION
  Wraps the PNG bytes inside a single ICONDIR + ICONDIRENTRY header.
  Windows Vista+ supports PNG-compressed icon entries, so a 256x256 PNG
  works as-is. The same pattern as issuer/make-ico.ps1.
#>

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$SrcPng = '..\frontend\public\mpd.png'
$DstIco = 'assets\mpd.ico'

if (-not (Test-Path $SrcPng)) {
    throw "Source PNG not found at $SrcPng"
}
if (-not (Test-Path 'assets')) {
    New-Item -ItemType Directory -Path 'assets' | Out-Null
}

$png = [System.IO.File]::ReadAllBytes((Resolve-Path $SrcPng))
$pngLen = $png.Length

$out = New-Object System.IO.MemoryStream
$bw  = New-Object System.IO.BinaryWriter $out

# ICONDIR (6 bytes)
$bw.Write([uint16]0)          # reserved
$bw.Write([uint16]1)          # type = icon
$bw.Write([uint16]1)          # image count = 1

# ICONDIRENTRY (16 bytes)
$bw.Write([byte]0)            # width  (0 = 256+)
$bw.Write([byte]0)            # height (0 = 256+)
$bw.Write([byte]0)            # color palette
$bw.Write([byte]0)            # reserved
$bw.Write([uint16]1)          # color planes
$bw.Write([uint16]32)         # bits per pixel
$bw.Write([uint32]$pngLen)    # bytes in image
$bw.Write([uint32]22)         # offset (6 header + 16 entry)

# Image data (raw PNG bytes)
$bw.Write($png)
$bw.Flush()

[System.IO.File]::WriteAllBytes((Join-Path $PSScriptRoot $DstIco), $out.ToArray())
$out.Dispose()

Write-Host "Wrote $DstIco ($pngLen bytes PNG -> $($pngLen + 22) bytes ICO)" -ForegroundColor Green

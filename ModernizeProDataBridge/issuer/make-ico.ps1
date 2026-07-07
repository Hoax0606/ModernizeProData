#requires -Version 5.1
<#
.SYNOPSIS
  Build mpd.ico from mpd.png for use by jpackage --icon.

.DESCRIPTION
  Generates a single-image PNG-embedded .ico file (declared as 256x256
  which makes Windows accept higher-resolution embedded PNG data). Windows
  Vista+ supports PNG-compressed icon entries, so we just wrap the PNG
  bytes inside an ICONDIR + ICONDIRENTRY header.
#>

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$SrcPng = 'src\main\resources\com\ksinfo\license\issuer\mpd.png'
$DstIco = 'src\main\resources\com\ksinfo\license\issuer\mpd.ico'

if (-not (Test-Path $SrcPng)) {
    throw "Source PNG not found at $SrcPng"
}

$png = [System.IO.File]::ReadAllBytes((Resolve-Path $SrcPng))
$pngLen = $png.Length

$out = New-Object System.IO.MemoryStream
$bw  = New-Object System.IO.BinaryWriter $out

# ICONDIR (6 bytes)
$bw.Write([uint16]0)          # reserved
$bw.Write([uint16]1)          # type = icon (1 = ICO, 2 = CUR)
$bw.Write([uint16]1)          # image count = 1

# ICONDIRENTRY (16 bytes)
$bw.Write([byte]0)            # width  (0 = 256+)
$bw.Write([byte]0)            # height (0 = 256+)
$bw.Write([byte]0)            # color palette (0 if no palette)
$bw.Write([byte]0)            # reserved
$bw.Write([uint16]1)          # color planes
$bw.Write([uint16]32)         # bits per pixel
$bw.Write([uint32]$pngLen)    # bytes in image
$bw.Write([uint32]22)         # offset (6 header + 16 entry)

# Image data (raw PNG bytes 窶・Vista+ recognises PNG-embedded icons)
$bw.Write($png)
$bw.Flush()

[System.IO.File]::WriteAllBytes((Join-Path $PSScriptRoot $DstIco), $out.ToArray())
$out.Dispose()

Write-Host "Wrote $DstIco ($pngLen bytes PNG 竊・$($pngLen + 22) bytes ICO)" -ForegroundColor Green

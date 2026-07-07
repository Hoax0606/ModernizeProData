# Regenerate installer-banner.bmp (493x58) and installer-dialog.bmp (493x312)
# from frontend/public/mpd.png. WiX 3.x expects 24-bit RGB BMPs at these
# fixed dimensions for WixUIBannerBmp / WixUIDialogBmp.
#
# Layout:
#   dialog (493x312)   left strip 164 wide = pale mint with the mpd logo
#                      centered; right area 329 wide = white (WiX overlays
#                      the welcome text here).
#   banner (493x58)    left strip 164 wide = pale mint; right area = white
#                      (WiX overlays the step title here).

#requires -Version 5.1
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

Add-Type -AssemblyName System.Drawing

$src = Resolve-Path '..\frontend\public\mpd.png'
$outDir = Resolve-Path 'resources\wix'

# Pale mint to match the brand without overpowering the wizard text.
$paleMint = [System.Drawing.Color]::FromArgb(212, 234, 230)   # #d4eae6
$white    = [System.Drawing.Color]::White

$logo = [System.Drawing.Image]::FromFile($src.Path)

function Save-Bmp24 {
    param([System.Drawing.Bitmap]$Bmp, [string]$Path)
    # Force 24-bit RGB so WiX/light.exe accepts it.
    $rgb = New-Object System.Drawing.Bitmap($Bmp.Width, $Bmp.Height, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
    $g = [System.Drawing.Graphics]::FromImage($rgb)
    $g.DrawImage($Bmp, 0, 0, $Bmp.Width, $Bmp.Height)
    $g.Dispose()
    $rgb.Save($Path, [System.Drawing.Imaging.ImageFormat]::Bmp)
    $rgb.Dispose()
}

# ---- dialog (493x312) ----
$dlg = New-Object System.Drawing.Bitmap(493, 312)
$g = [System.Drawing.Graphics]::FromImage($dlg)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic

# White everywhere first, then pale mint left strip on top.
$g.FillRectangle((New-Object System.Drawing.SolidBrush($white)),    0, 0, 493, 312)
$g.FillRectangle((New-Object System.Drawing.SolidBrush($paleMint)), 0, 0, 164, 312)

# Center the logo in the left strip. Cap at 130 px so it doesn't crowd the edges.
$logoSize = 130
$logoX = [int](((164 - $logoSize) / 2))
$logoY = [int](((312 - $logoSize) / 2))
$g.DrawImage($logo, $logoX, $logoY, $logoSize, $logoSize)
$g.Dispose()

Save-Bmp24 -Bmp $dlg -Path (Join-Path $outDir 'installer-dialog.bmp')
$dlg.Dispose()
Write-Host "Wrote installer-dialog.bmp (493x312, pale-mint strip + centered logo)" -ForegroundColor Green

# ---- banner (493x58) ----
$bnr = New-Object System.Drawing.Bitmap(493, 58)
$g = [System.Drawing.Graphics]::FromImage($bnr)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic

# WiX puts the step title on the LEFT of the banner and a small graphic on
# the RIGHT. Mirror that: white on the left for the title text, pale mint
# strip with the logo on the right.
$g.FillRectangle((New-Object System.Drawing.SolidBrush($white)),    0, 0, 493, 58)
$g.FillRectangle((New-Object System.Drawing.SolidBrush($paleMint)), 432, 0, 61, 58)

$smallSize = 48
$smallX = 432 + [int]((61 - $smallSize) / 2)
$smallY = [int]((58 - $smallSize) / 2)
$g.DrawImage($logo, $smallX, $smallY, $smallSize, $smallSize)
$g.Dispose()

Save-Bmp24 -Bmp $bnr -Path (Join-Path $outDir 'installer-banner.bmp')
$bnr.Dispose()
Write-Host "Wrote installer-banner.bmp (493x58, logo on right)" -ForegroundColor Green

$logo.Dispose()

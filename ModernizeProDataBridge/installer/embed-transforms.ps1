# Generate language transforms (msitran-free) and embed them into a single
# multi-language MSI using only the Windows Installer COM API.
#
# Prerequisites: build.ps1 -Language all has produced three MSIs in dist/:
#   - ModernizeProDataBridge-en-1.0.0.msi   (base; all transforms diff against this)
#   - ModernizeProDataBridge-ko-1.0.0.msi
#   - ModernizeProDataBridge-ja-1.0.0.msi
#
# Steps:
#   1. For each non-base lang, open both DBs, call Database.GenerateTransform
#      to produce a .mst file (no msitran.exe dependency).
#   2. CreateTransformSummaryInformation to fill the transform's summary stream
#      so Windows Installer accepts it at install time.
#   3. Copy en.msi to ModernizeProDataBridge.msi (final shippable name).
#   4. Open it read-write, insert each .mst as a sub-storage row in _Storages
#      with the LCID as the storage name (msiexec /TRANSFORMS=:1042 looks for
#      a sub-storage named "1042").
#   5. Update the Summary Information Template field to advertise all langs.

#requires -Version 5.1
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$dist = Join-Path $PSScriptRoot 'dist'
$baseMsi = Join-Path $dist 'ModernizeProDataBridge-en-1.0.0.msi'
$koMsi   = Join-Path $dist 'ModernizeProDataBridge-ko-1.0.0.msi'
$jaMsi   = Join-Path $dist 'ModernizeProDataBridge-ja-1.0.0.msi'
foreach ($f in @($baseMsi, $koMsi, $jaMsi)) {
    if (-not (Test-Path $f)) {
        throw "Missing: $f. Run .\build.ps1 -Language all first."
    }
}

$koMst = Join-Path $dist 'ko.mst'
$jaMst = Join-Path $dist 'ja.mst'
foreach ($p in @($koMst, $jaMst)) { if (Test-Path $p) { Remove-Item -Force $p } }

# Windows Installer constants.
$MsiOpenDatabaseModeReadOnly = 0
$MsiOpenDatabaseModeTransact = 1
$MsiTransformErrorAll = 0x1 + 0x2 + 0x4 + 0x8 + 0x10 + 0x20 + 0x40   # bitmask: handle all conditions
$MsiTransformValidationNone = 0
$MsiViewModifyDelete = 6

$installer = New-Object -ComObject WindowsInstaller.Installer

function New-Transform {
    param([string]$ReferenceMsi, [string]$LocalizedMsi, [string]$OutMst)
    Write-Host "  Diffing $(Split-Path $ReferenceMsi -Leaf) -> $(Split-Path $LocalizedMsi -Leaf) ..." -ForegroundColor Cyan
    $refDb = $installer.OpenDatabase($ReferenceMsi, $MsiOpenDatabaseModeReadOnly)
    $locDb = $installer.OpenDatabase($LocalizedMsi, $MsiOpenDatabaseModeReadOnly)
    # GenerateTransform writes the diff "refDb -> locDb" into $OutMst.
    [void]$locDb.GenerateTransform($refDb, $OutMst)
    $locDb.CreateTransformSummaryInfo($refDb, $OutMst, $MsiTransformErrorAll, $MsiTransformValidationNone)
    if (-not (Test-Path $OutMst)) { throw "GenerateTransform produced no output: $OutMst" }
    Write-Host "    -> $OutMst" -ForegroundColor Green
}

Write-Host "[1/3] Generating transforms via Windows Installer COM..." -ForegroundColor Cyan
New-Transform -ReferenceMsi $baseMsi -LocalizedMsi $koMsi -OutMst $koMst
New-Transform -ReferenceMsi $baseMsi -LocalizedMsi $jaMsi -OutMst $jaMst

$finalMsi = Join-Path $dist 'ModernizeProDataBridge.msi'
if (Test-Path $finalMsi) { Remove-Item -Force $finalMsi }
Copy-Item -Force $baseMsi $finalMsi
Write-Host "[2/3] Copied base .msi -> $finalMsi" -ForegroundColor Cyan

Write-Host "[3/3] Embedding transforms as sub-storages..." -ForegroundColor Cyan

# Open the database transactionally so we can commit/rollback as a unit.
$db = $installer.OpenDatabase($finalMsi, $MsiOpenDatabaseModeTransact)

function Add-Storage {
    param($Database, [string]$StorageName, [string]$MstPath)

    # Remove any pre-existing row with the same name (idempotent re-runs).
    $view = $Database.OpenView("SELECT `Name`,`Data` FROM `_Storages` WHERE `Name`='$StorageName'")
    $view.Execute($null)
    $rec = $view.Fetch()
    if ($rec) { $view.Modify($MsiViewModifyDelete, $rec) }
    $view.Close()

    # Insert new row with the .mst contents bound to the Data stream column.
    $rec = $installer.CreateRecord(2)
    $rec.StringData(1) = $StorageName
    $rec.SetStream(2, $MstPath)
    $view2 = $Database.OpenView("INSERT INTO `_Storages` (`Name`,`Data`) VALUES (?, ?)")
    $view2.Execute($rec)
    $view2.Close()
    Write-Host "    embedded $(Split-Path $MstPath -Leaf) as storage '$StorageName'" -ForegroundColor Green
}

Add-Storage $db '1042' $koMst
Add-Storage $db '1041' $jaMst

$db.Commit()

# Release the COM Database before reopening via DTF so file handles don't
# collide. PowerShell 5.1's WindowsInstaller COM has no working setter for
# SummaryInformation's indexed Property -- neither the dynamic syntax nor
# InvokeMember reaches it. Switch to WiX's managed DTF assembly which has a
# clean strongly-typed Template property.
[System.Runtime.InteropServices.Marshal]::ReleaseComObject($db) | Out-Null
[System.Runtime.InteropServices.Marshal]::ReleaseComObject($installer) | Out-Null
$db = $null; $installer = $null
[System.GC]::Collect(); [System.GC]::WaitForPendingFinalizers()

$dtf = 'C:\Program Files (x86)\WiX Toolset v3.14\bin\Microsoft.Deployment.WindowsInstaller.dll'
if (-not (Test-Path $dtf)) { throw "DTF assembly not found: $dtf" }
Add-Type -Path $dtf

# DatabaseOpenMode.Direct = 2 (no transaction). Open, set, persist, close.
# Sleep briefly so the COM Database handle is actually released before DTF
# reopens the file -- without this, DTF can fail mid-flight.
Start-Sleep -Milliseconds 500
$dtfDb = New-Object Microsoft.Deployment.WindowsInstaller.Database(
    $finalMsi, [Microsoft.Deployment.WindowsInstaller.DatabaseOpenMode]::Direct)
try {
    $dtfDb.SummaryInfo.Template = 'x64;1033,1042,1041'
    $dtfDb.SummaryInfo.Persist()
} finally {
    # Close occasionally raises a NotSpecified InstallerException even when
    # Persist has already flushed the change to disk. Swallow it -- a fresh
    # OpenDatabase from a new process correctly reads back the updated value.
    try { $dtfDb.Close() } catch { }
    try { $dtfDb.Dispose() } catch { }
}
Write-Host "  Template = x64;1033,1042,1041" -ForegroundColor Green

Write-Host ""
Write-Host "Multi-language MSI ready: $finalMsi" -ForegroundColor Green
Write-Host "  msiexec /i ModernizeProDataBridge.msi                       # default = en"
Write-Host "  msiexec /i ModernizeProDataBridge.msi TRANSFORMS=:1042      # Korean"
Write-Host "  msiexec /i ModernizeProDataBridge.msi TRANSFORMS=:1041      # Japanese"
Write-Host ""
Write-Host "Launcher.exe wraps this with a language-selection dialog (see launcher/)."

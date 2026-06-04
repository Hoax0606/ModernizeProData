# ModernizeProData cleanup -- run as admin
$packed  = "FB10E024EE495CE3F991394C3C37A397"
$sid     = "S-1-5-21-3322844094-1642998784-2093105868-1001"
$product = "{420E01BF-94EE-3EC5-9F19-93C4C3733A79}"

$uninstall = "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\$product"
$prodKey   = "HKLM:\Software\Microsoft\Windows\CurrentVersion\Installer\UserData\$sid\Products\$packed"
$compRoot  = "HKLM:\Software\Microsoft\Windows\CurrentVersion\Installer\UserData\$sid\Components"

Remove-Item $uninstall -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item $prodKey   -Recurse -Force -ErrorAction SilentlyContinue

$cleaned = 0
$denied = 0
Get-ChildItem $compRoot -ErrorAction SilentlyContinue | ForEach-Object {
    $vals = (Get-Item $_.PSPath).GetValueNames()
    if ($vals -contains $packed) {
        try {
            Remove-ItemProperty $_.PSPath -Name $packed -Force -ErrorAction Stop
            $cleaned++
        } catch {
            # TrustedInstaller/SYSTEM owned key. orphan reference 는 무해 (다음 install 영향 없음).
            $denied++
        }
    }
}
Write-Output "components cleaned = $cleaned (skipped/denied = $denied — harmless)"

Remove-Item "$env:LOCALAPPDATA\ModernizeProData" -Recurse -Force -ErrorAction SilentlyContinue

Get-ChildItem "C:\Windows\Installer" -Filter "*.msi" -ErrorAction SilentlyContinue | ForEach-Object {
    try {
        $wi = New-Object -ComObject WindowsInstaller.Installer
        $db = $wi.GetType().InvokeMember("OpenDatabase","InvokeMethod",$null,$wi,@($_.FullName,0))
        $sql = "SELECT ``Value`` FROM ``Property`` WHERE ``Property``='ProductName'"
        $view = $db.GetType().InvokeMember("OpenView","InvokeMethod",$null,$db,@($sql))
        $view.GetType().InvokeMember("Execute","InvokeMethod",$null,$view,$null)
        $rec = $view.GetType().InvokeMember("Fetch","InvokeMethod",$null,$view,$null)
        if ($rec) {
            $name = $rec.GetType().InvokeMember("StringData","GetProperty",$null,$rec,@(1))
            if ($name -like "*ModernizeProData*") { Remove-Item $_.FullName -Force }
        }
    } catch {}
}

Remove-Item "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\ModernizeProData" -Recurse -Force -ErrorAction SilentlyContinue

$wshell = New-Object -ComObject WScript.Shell
$desktops = @(
    [Environment]::GetFolderPath('Desktop'),
    [Environment]::GetFolderPath('CommonDesktopDirectory')
) | Sort-Object -Unique
foreach ($d in $desktops) {
    if (-not (Test-Path $d)) { continue }
    Get-ChildItem $d -Filter "*.lnk" -ErrorAction SilentlyContinue | ForEach-Object {
        try {
            $lnk = $wshell.CreateShortcut($_.FullName)
            if ($lnk.TargetPath -match 'ModernizeProData') {
                Remove-Item $_.FullName -Force
                Write-Output "removed shortcut: $($_.FullName)"
            }
        } catch {}
    }
}

Remove-Item "C:\KSINFO\DataMigrationTool\ModernizeProData\installer\dist\ModernizeProData-en-1.0.0.msi" -Force -ErrorAction SilentlyContinue
Remove-Item "C:\KSINFO\DataMigrationTool\ModernizeProData\installer\dist\ModernizeProData-Worker-en-1.0.0.msi" -Force -ErrorAction SilentlyContinue

Write-Output "---verify---"
$r = Get-ItemProperty HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\* -ErrorAction SilentlyContinue | Where-Object DisplayName -like "*ModernizeProData*"
if ($r) { Write-Output "STILL: $($r.PSChildName)" } else { Write-Output "OK: uninstall entry gone" }
if (Test-Path "$env:LOCALAPPDATA\ModernizeProData") { Write-Output "STILL: install dir" } else { Write-Output "OK: install dir gone" }

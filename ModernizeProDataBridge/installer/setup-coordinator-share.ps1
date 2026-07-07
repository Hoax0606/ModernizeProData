#requires -Version 5.1
#requires -RunAsAdministrator
<#
.SYNOPSIS
  Coordinator PC 에서 1회 실행 — Worker (다른 PC) 들이 CSV / DDL 등을 read 할
  사내 SMB share 를 설정한다.

.DESCRIPTION
  Modernize Pro Data 의 4대 분산 운영 (1 Coordinator + 3 Worker) 에서 Worker
  들이 Coordinator PC 의 한 폴더를 SMB 로 read 하도록 정리한다.

  자동 처리 항목:
    1. 폴더 생성 (기본 C:\KSINFO\modernize-share)
    2. SMB share 등록 (기본 이름 'modernize', Everyone Full Access)
    3. NTFS ACL — Everyone Modify (SMB + NTFS 양쪽 모두 통과해야 read/write)
    4. Windows Firewall 의 'File and Printer Sharing' inbound rule 활성

  실행 전제:
    - Administrator 권한 PowerShell 에서 실행 (#requires 가 강제).
    - Coordinator PC + Worker PC 들이 같은 사내 LAN.
    - 사내 LAN 외부 노출 안 됨 (방화벽이 외부 inbound 차단).

  실행 후 Worker PC 에서 접근:
    \\<Coordinator-PC>\modernize       (NetBIOS 이름)
    \\<Coordinator LAN IP>\modernize   (IP 직접)

  Coordinator master 가 Site 설정의 csvPath 에 위 UNC 경로를 입력하면
  4대 모두 같은 CSV 폴더를 본다.

.PARAMETER SharePath
  공유 폴더 절대 경로. 없으면 자동 생성. 기본: C:\KSINFO\modernize-share

.PARAMETER ShareName
  SMB share 이름. 기본: modernize

.PARAMETER AccessIdentity
  공유 access 부여 대상. 사내 LAN 기본은 'Everyone'. AD 환경이면 'Domain Users' 등.

.EXAMPLE
  # 기본값으로 셋업
  .\setup-coordinator-share.ps1

.EXAMPLE
  # 다른 경로 / 도메인 환경
  .\setup-coordinator-share.ps1 -SharePath D:\modernize -AccessIdentity "Domain Users"
#>

param(
    [string]$SharePath = 'C:\KSINFO\modernize-share',
    [string]$ShareName = 'modernize',
    [string]$AccessIdentity = 'Everyone'
)

$ErrorActionPreference = 'Stop'

Write-Host ""
Write-Host "=== Modernize Pro Data — Coordinator SMB share setup ===" -ForegroundColor Cyan
Write-Host "SharePath      : $SharePath"
Write-Host "ShareName      : $ShareName"
Write-Host "AccessIdentity : $AccessIdentity"
Write-Host ""

# [1/4] Folder
if (-not (Test-Path $SharePath)) {
    New-Item -ItemType Directory -Path $SharePath -Force | Out-Null
    Write-Host "[1/4] Created folder $SharePath" -ForegroundColor Green
} else {
    Write-Host "[1/4] Folder already exists: $SharePath" -ForegroundColor Yellow
}

# [2/4] SMB share — 기존 동명 share 있으면 교체.
$existing = Get-SmbShare -Name $ShareName -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "[2/4] Removing existing share '$ShareName' (was -> $($existing.Path))" -ForegroundColor Yellow
    Remove-SmbShare -Name $ShareName -Force -Confirm:$false
}
New-SmbShare `
    -Name $ShareName `
    -Path $SharePath `
    -FullAccess $AccessIdentity `
    -Description "Modernize Pro Data shared storage (CSV / DDL)" | Out-Null
Write-Host "[2/4] Created SMB share '$ShareName' with FullAccess for '$AccessIdentity'" -ForegroundColor Green

# [3/4] NTFS ACL — Modify on Everyone (또는 AccessIdentity).
$acl = Get-Acl $SharePath
$rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
    $AccessIdentity, 'Modify',
    'ContainerInherit,ObjectInherit', 'None', 'Allow'
)
$acl.SetAccessRule($rule)
Set-Acl -Path $SharePath -AclObject $acl
Write-Host "[3/4] Granted NTFS Modify to '$AccessIdentity' on $SharePath" -ForegroundColor Green

# [4/4] Firewall — File and Printer Sharing inbound.
$fwRules = Get-NetFirewallRule -DisplayGroup "File and Printer Sharing" -ErrorAction SilentlyContinue
if ($fwRules) {
    Enable-NetFirewallRule -DisplayGroup "File and Printer Sharing"
    Write-Host "[4/4] Enabled firewall rule group 'File and Printer Sharing'" -ForegroundColor Green
} else {
    Write-Host "[4/4] Firewall rule group 'File and Printer Sharing' not found — skipped" -ForegroundColor Yellow
}

# Summary
$ipList = (Get-NetIPAddress -AddressFamily IPv4 -PrefixOrigin Dhcp,Manual `
    -ErrorAction SilentlyContinue |
    Where-Object { $_.IPAddress -notlike '169.254.*' -and $_.IPAddress -ne '127.0.0.1' } |
    Select-Object -ExpandProperty IPAddress)
$pcName = $env:COMPUTERNAME

Write-Host ""
Write-Host "=== Done ===" -ForegroundColor Cyan
Write-Host "Worker PC 에서 다음 UNC 경로 중 하나로 접근 가능:"
Write-Host "  \\$pcName\$ShareName"
foreach ($ip in $ipList) {
    Write-Host "  \\$ip\$ShareName"
}
Write-Host ""
Write-Host "Coordinator master 가 Site 설정에서 csvPath 에 위 UNC 경로를 입력하면 됩니다."
Write-Host ""

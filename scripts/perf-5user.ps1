# 5-user concurrent load test -- scenario 1 (5 pollers + master setBaseline race).
# Windows PowerShell 5.1 compatible (Start-Job, no -Parallel).
# Run while backend dev (HIBERNATE_STATS=true) is up.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File perf-5user.ps1
#   powershell -ExecutionPolicy Bypass -File perf-5user.ps1 -DurationSec 180

param(
  [string]$BaseUrl = "http://localhost:8080",
  [int]$DurationSec = 120,
  [string]$User = "master",
  [string]$Pass = "password",
  [string]$Site = "s-5cab3b04",
  [string]$SnapId = "ss-5edd20e2"
)

# login (main)
$loginBody = @{ username = $User; password = $Pass } | ConvertTo-Json
try {
  $login = Invoke-RestMethod "$BaseUrl/api/v1/auth/login" -Method Post -ContentType "application/json" -Body $loginBody
  $token = $login.data.token
} catch {
  Write-Host ("LOGIN FAILED: " + $_.Exception.Message) -ForegroundColor Red
  exit 1
}
if (-not $token) { Write-Host "no token in response" -ForegroundColor Red; exit 1 }
Write-Host ("login ok (" + $User + "), token len=" + $token.Length) -ForegroundColor Green
Write-Host ("5 pollers x " + $DurationSec + "s + setBaseline race ... running") -ForegroundColor Cyan

# poller job: listBySite loop, returns latency list + error count
$pollerBlock = {
  param($b, $t, $s, $dur)
  $end = (Get-Date).AddSeconds($dur)
  $h = @{ Authorization = "Bearer $t" }
  $lat = @()
  $errs = 0
  while ((Get-Date) -lt $end) {
    $ok = $true
    $ms = (Measure-Command {
      try { Invoke-RestMethod "$b/api/v1/sites/$s/snapshots" -Headers $h -TimeoutSec 60 | Out-Null }
      catch { $script:ok = $false }
    }).TotalMilliseconds
    $lat += $ms
    if (-not $ok) { $errs++ }
    Start-Sleep -Milliseconds 800
  }
  [PSCustomObject]@{ kind = 'listBySite'; lat = $lat; errs = $errs }
}

# baseline job: toggle setBaseline (race + retry)
$baselineBlock = {
  param($b, $t, $sid, $dur)
  $end = (Get-Date).AddSeconds($dur)
  $h = @{ Authorization = "Bearer $t" }
  $errs = 0
  while ((Get-Date) -lt $end) {
    try {
      Invoke-RestMethod "$b/api/v1/snapshots/$sid/baseline" -Method Post -Headers $h -TimeoutSec 60 | Out-Null
      Invoke-RestMethod "$b/api/v1/snapshots/$sid/baseline" -Method Delete -Headers $h -TimeoutSec 60 | Out-Null
    } catch { $errs++ }
    Start-Sleep -Milliseconds 2000
  }
  [PSCustomObject]@{ kind = 'setBaseline'; lat = @(); errs = $errs }
}

$jobs = @()
1..5 | ForEach-Object {
  $jobs += Start-Job -ScriptBlock $pollerBlock -ArgumentList $BaseUrl, $token, $Site, $DurationSec
}
$jobs += Start-Job -ScriptBlock $baselineBlock -ArgumentList $BaseUrl, $token, $SnapId, $DurationSec

$results = $jobs | Wait-Job | Receive-Job
$jobs | Remove-Job

# aggregate
$listLat = @()
$listErr = 0; $baseErr = 0
foreach ($r in $results) {
  if ($r.kind -eq 'listBySite') { $listLat += $r.lat; $listErr += $r.errs }
  elseif ($r.kind -eq 'setBaseline') { $baseErr += $r.errs }
}
$sorted = @($listLat | Sort-Object)
$n = $sorted.Count
function Pctl($arr, $p) { if ($arr.Count -eq 0) { return 0 }; return [math]::Round($arr[[math]::Min($arr.Count-1, [int]($arr.Count * $p))]) }

Write-Host ""
Write-Host ("=== listBySite (n=" + $n + ") ===") -ForegroundColor Yellow
if ($n -gt 0) {
  $mean = [math]::Round(($sorted | Measure-Object -Average).Average)
  $p50 = Pctl $sorted 0.5
  $p95 = Pctl $sorted 0.95
  $mx = [math]::Round($sorted[-1])
  Write-Host ("  mean=" + $mean + "ms  p50=" + $p50 + "ms  p95=" + $p95 + "ms  max=" + $mx + "ms  errors=" + $listErr)
}
Write-Host "=== setBaseline ===" -ForegroundColor Yellow
Write-Host ("  errors=" + $baseErr)
Write-Host ""
Write-Host "server truth: backend log [perf] lines. target peak under 1000ms" -ForegroundColor Cyan

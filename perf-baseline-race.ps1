# setBaseline OptimisticLock race test.
# Same project, different snapshots, concurrent setBaseline -> restoreMapping
# cascade DELETE race -> ObjectOptimisticLockingFailureException -> backend retry.
# Verifies inflight(FE, N/A here) + @Retryable(BE) handles it (final error should be ~0).
# Windows PowerShell 5.1 compatible.

param(
  [string]$BaseUrl = "http://localhost:8080",
  [int]$Rounds = 40,
  [string]$User = "master",
  [string]$Pass = "password"
)

# snapshots in same project p-b757637c (install PG, race target)
$snaps = @('ss-5edd20e2','ssperf-2be91c0daf','ssperf-d1644cb1e8','ssperf-2579def8f2','ssperf-486f0c2191','ssperf-377dccd27f')

# login
$loginBody = @{ username = $User; password = $Pass } | ConvertTo-Json
try {
  $login = Invoke-RestMethod "$BaseUrl/api/v1/auth/login" -Method Post -ContentType "application/json" -Body $loginBody
  $token = $login.data.token
} catch { Write-Host ("LOGIN FAILED: " + $_.Exception.Message) -ForegroundColor Red; exit 1 }
Write-Host ("login ok, racing " + $snaps.Count + " snapshots x " + $Rounds + " rounds") -ForegroundColor Cyan

# each thread: hammer setBaseline on its own snapshot (same project) repeatedly
$raceBlock = {
  param($b, $t, $sid, $rounds)
  $h = @{ Authorization = "Bearer $t" }
  $ok = 0; $err = 0; $errMsgs = @()
  for ($i = 0; $i -lt $rounds; $i++) {
    try {
      Invoke-RestMethod "$b/api/v1/snapshots/$sid/baseline" -Method Post -Headers $h -TimeoutSec 60 | Out-Null
      $ok++
    } catch {
      $err++
      $code = $null
      try { $code = $_.Exception.Response.StatusCode.value__ } catch {}
      $errMsgs += ("" + $code)
    }
    Start-Sleep -Milliseconds 50
  }
  [PSCustomObject]@{ sid = $sid; ok = $ok; err = $err; codes = ($errMsgs -join ',') }
}

$jobs = @()
foreach ($s in $snaps) {
  $jobs += Start-Job -ScriptBlock $raceBlock -ArgumentList $BaseUrl, $token, $s, $Rounds
}
$results = $jobs | Wait-Job | Receive-Job
$jobs | Remove-Job

$totalOk = 0; $totalErr = 0
Write-Host ""
Write-Host "=== per-snapshot ===" -ForegroundColor Yellow
foreach ($r in ($results | Sort-Object sid)) {
  $totalOk += $r.ok; $totalErr += $r.err
  $codeSummary = if ($r.err -gt 0) { " codes=[" + $r.codes + "]" } else { "" }
  Write-Host ("  " + $r.sid + ": ok=" + $r.ok + " err=" + $r.err + $codeSummary)
}
Write-Host ""
Write-Host ("TOTAL ok=" + $totalOk + " err=" + $totalErr) -ForegroundColor Yellow
Write-Host "backend log: look for 'setBaseline retry N/3' (retry working) and 'failed after 3 attempts' (retry exhausted)" -ForegroundColor Cyan

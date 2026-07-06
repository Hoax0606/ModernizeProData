# 2026-05-31 — running-kpi-semantic (jiyeong)

`ExecutionOverviewPage` (All Projects > Execution) 의 "Running" 표기가 두 위치에서
**다른 의미**로 쓰여 사용자 혼동 가능 — 조사 후 결정은 내일로 미룸.

## 한 일

- **validation 합병 commit** (`ee3f19a`): `LocalWorkerExecutor.NON_BLOCKING_STAGES`
  제거, `ValidationReportService` FAIL 시 `QuarantineService.recordQuarantine`
  자동 호출 (`validate.sum_recon` / `validate.min_max` / `validate.null_parity` /
  `validate.row_count` / `validate.checksum`). `ArtifactsPage` mock ~240 라인 cleanup,
  `SiteExportPage` + `siteExportManifest` Validation zip 실 데이터 wire (`validationApi.listByRun`
  → `validationRowsFor`). zip bundle 4 카테고리 (Migration/Mapping/Validation/Site summary)
  모두 real BE.
- **phaseChipColor revert** (commit 없음, 미커밋 변경 cancel): `ExecutionOverviewPage.tsx:656`
  의 runStatus 분기 (red/amber) 제거 → 사이드바 `AppShell.phaseColors` 와 동일한
  단순 neutral gray. failed run 표시는 pipeline tile + errorCount column 책임.
- **Running KPI 의미 조사**: 위치 / 데이터 출처 / mismatch 케이스 파악, plan 파일에 정리.

## 다음 사람이 할 일

- 4 가지 중 결정 (plan 파일 참조):
  1. 변경 없음
  2. KPI 라벨 → "Active phase" / "In execution" (i18n ko/ja/en 동기)
  3. KPI 카운트 기준 → `runStatus === 'running'` (toolbar 와 통일)
  4. `runningPhases` 에서 `hypercare` 만 제거 (CLAUDE.md 도메인 정렬)
- 결정 후 `ExecutionOverviewPage.tsx:282` (runningPhases) + `:378` (KPI label) + i18n key
  `executionOverview.kpi.running` 갱신.

## 함정 / 결정 이력

- **KPI vs toolbar mismatch 정상 케이스**: KPI = phase 기준 project 수
  (`runningPhases = ['cutover','rehearsal','hypercare','test']`), toolbar 힌트 =
  `runStatus === 'running'` run 수. 같은 "Running" 라벨이지만 숫자가 다를 수 있음
  (예: hypercare 진입 직후 = KPI 1 / toolbar 0).
- **hypercare 포함의 도메인 불일치**: `CLAUDE.md` Phase 모델은 "runStatus 는
  test/rehearsal/cutover sub-status" — hypercare 는 runStatus 없음. 그런데
  `runningPhases` 가 hypercare 포함 → 의도가 phase-centric (실행 단계 진입) 으로
  보이나 라벨이 모호.
- **phaseChipColor 어제 변경 walk back**: 2026-05-30 도입한 active phase +
  failed/aborted → red/amber 분기를 사이드바 일관성을 위해 revert. failed run
  표시 책임은 phase chip 이 아니라 다른 UI 채널.

## 안 한 것 (의도적으로)

- Running KPI 코드 변경 — 선택지 결정 후 진행.
- AppShell `phaseColors` / DashboardPage `phaseChipColor` 통합 refactor — 현재 모두
  단순 neutral gray 패턴이라 정렬돼 있음. 공통 util 추출은 nice-to-have.

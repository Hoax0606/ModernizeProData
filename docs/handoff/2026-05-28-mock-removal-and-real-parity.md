# 2026-05-28 — mock-removal-and-real-parity (Jiyeong Im)

PoC1 = 현장 배포 수준 기준 충족을 위해 mock simulation 완전 제거 + real-mode parity wiring + 다수 production-grade fix. 이전 `2026-05-28-execution-tobe-db-env-key` 의 후속.

## 한 일

### BE 데이터 정확성 (silent corruption 제거)
- **CSV schema-qualified 해석** (`StageHelpers` shared util) — `{schema}.{table}.csv` → `{table}.csv` 순. `CheckStage`·`ExtractStage`·`RunStageCacheService`·`SiteCsvPreviewController`·`MappingReportService` 모두 같은 규칙. FE `csvPreviewApi.forTable` 도 schema 포함 이름 전달.
- **COPY 명시 컬럼 리스트** (`PgCopyManager.copyInFromCsv` 4-arg overload) — `COPY {t} ("c1","c2",...) FROM stdin`. CSV 필드를 이름 매핑으로 PG 적재 → mapping_rules 순서 ≠ PG DDL ordinal 어긋남으로 인한 silent 컬럼 misalignment 방지. `LoadStage` 가 DuckDB tobe_ 컬럼명 metadata 로 컬럼 리스트 구성.
- **`PROD_ENV` "prod" → "production"** — FE `ProjectEnvironment` 값과 일치, cutover 게이트 정상 동작.
- **`RunService.startRun` 의 phase auto-advance** — runMode=test 면 `analysis < test` 일 때 `test` 로 자동 전이 (rehearsal 도 동일). cutover 는 별도 라이프사이클(별도 작업).
- **`LocalWorkerExecutor` 의 run.status 집계** — gate 안 났어도 stage 하나라도 failed 면 throw → `failRun` 호출 → run = `failed`. 이전엔 "전 stage failed인데 run=success" 표시 버그.

### FE Real-mode parity (mock 제거 전 wiring)
- **G1 `DashboardPage` RUN STATUS KPI** — mock activeRun → `runsApi.listByProject` 10s polling. 최신 run 1건 표시.
- **G2 `ExecutionOverviewPage` per-row pipeline** — mock activeRun + 500ms tick → `ProjectExecMetrics.progressPct`/`runStatus` 기반 단일 progress 단순 배포. 7 stage 정밀 chip 은 PoC2 에서 BE per-stage metric 추가 후.

### FE Execution UX fix
- **Retry no-op** (real 모드) — `startRealRun` helper 분리해서 stale `activeRunId` guard 우회.
- **elapsed 라벨** — real 은 BE wall-clock(`haltedAt ?? pausedAt ?? now − startedAt`) 기반. 옛 mock 35초 cap 제거. mock ETA 미표시.
- **`N tables` 카운트** — `selectedTablesCount` prop 사용 (mock 의 빈 selectedTables 대신).
- **실패 배너** — `failedStageIndex` 불명 시 `errorBannerNoStage`("실행 실패 — {reason}") fallback 추가 (ko/ja/en).

### Mock simulation 완전 제거 (~885 LOC, 11 영역)
- 파일 삭제: `lib/useDemoMode.ts`, `lib/demoFixtures.ts`.
- `lib/pipelineStages.ts`: `STAGE_MS` / `TOTAL_STAGES` / `TOTAL_RUN_MS` / `computeElapsedMs` / `buildStagesFromActiveRun` 제거. `BASE_STAGES` 의 `defaultPct/defaultTone` 필드 제거 (idle/0 인라인).
- `store/executionPreflight.ts`: `ActiveRunState` / `ActiveRunStatus` / `newActiveRun` / `runCounter` / `activeRun` field + 8 데모 actions (start/pause/resume/finish/fail/abort/retry/clearActiveRun) 제거. persist v6 마이그레이트.
- `pages/ExecutionPage.tsx`: `useDemoMode` / `isDemo` / `demoMode` / `storeActiveRun` / `tick` / `demoStale` / `handleTriggerFail` / `handleExitDemo` / `DEMO_TABLES` / `buildDemoPreflightChecks` / `buildDemoPreflightPassChecks` / `buildRuns` 모두 제거. RunHeader · PreflightPanel demo props · trigger fail/Preview indicator JSX 제거. `ActiveRunState` 타입은 파일 내부로 inline.
- `layout/AppShell.tsx`: demo fixture inject effect + global mock finisher (`TOTAL_RUN_MS` 도달 시 finishActiveRun) + isDemoRef polling guard 제거.
- `pages/ApprovalsPage.tsx`: `isDemo` skip 분기 제거.
- `pages/MappingPage.tsx`: `isDemoProjectId` skip 제거.
- `pages/DashboardPage.tsx`: G1 wiring 으로 mock activeRun 의존 제거.
- `pages/ExecutionOverviewPage.tsx`: G2 wiring 으로 mock activeRun + tick 제거.
- i18n `execution.{run,preflight}.demo.*` 9 키 × 3 언어 = 27 entry 제거.

### 문서·테스트 데이터
- `docs/execution-review-guide.md` 신규 — 라이브 리뷰 체크리스트 · 테스트 데이터 커버리지 분석(19 케이스) · Execution 이 건드리는 DB 테이블 전수 · 디렉터리/하이브리드 아키텍처 · 알려진 한계(P0/P1/P2).
- `C:\KSINFO\TestData\samples-augmented\` (repo 밖 — 팀원에 전달) — BANKSYS 시나리오 보강 (bad row × 7), DDL_GUIDE.md, mapping additions (ori_* DDL 시나리오용).

## 다음 사람이 할 일

### P0 — silent corruption 잔여
1. `SqlComposer` **union** `SELECT *` 위치 매핑 — UNION'd CSV 컬럼 순서/이름 다르면 wrong. SHOP 시나리오 영향.
2. `SqlComposer` **join** `aliasFor` primary fallback — rule.asisTable 불일치 시 silent wrong-table.
3. COPY **NULL/empty-string + bool/date 타입 계약** — 빈 문자열↔NULL 모호, `'Y'/'1'`→bool 실패, 날짜 포맷.
4. **Row-level Quarantine 분리** — 정상 row 적재 + 위반 row parquet 보존 (현재 all-or-nothing per table). 마이그레이션 주석에 명시된 설계 의도 미구현.
5. `AuditStage` 가 cutover catalog 에서 빠짐 — cutover 가 NOT NULL/타입/PK 검증 없이 적재.

### P1 — 운영 안정성
6. abort/timeout/gate 시 `StageInstance.status` 잔존(`running`/`pending`) → FE 배지 불일치. `finishRun` 에서 비-terminal stage 들 마무리 필요.
7. abort 가 lock 먼저 풀고 executor 는 계속 실행 → 같은 TO-BE 테이블 동시 TRUNCATE/COPY 위험.
8. Paused run 을 `RunTimeoutSweeper` 가 안 잡음 → 영구 lock. sweeper 가 `paused` 도 포함해야.
9. Pre-register pause/abort race — start 직후 `register()` 전에 신호 오면 사일런트 누락.

### P2 — Artifacts BE wiring
10. `ArtifactsPage`/`SiteExportPage` 현재 100% client-side mock + ExcelJS. BE export endpoint 5종(dashboard/diff/ddl/sql/validation) + Site export job 필요. 자세한 건 `docs/execution-review-guide.md` §3.

### P3 — production build 잔재 (npm run build)
11. `VersionsPage.tsx`: `STATUS_KEY` / `Th` / `category` / `user` / `index` unused + `snapshot.changes` 속성 부재 + implicit any 다수.
12. `store/workspace.ts:318-360`: `project.cutover` 잔재 (`V20260522210001__drop_project_cutover.sql` 으로 drop 됐는데 코드는 잔존).
13. `store/asisDdl.ts:22`: `get` unused.
→ `tsc --noEmit` 은 통과하지만 production build strict mode 가 catch. mock 제거와 무관한 사전 issue.

### 검증 환경
14. 사용자 BE 재기동 → BANKSYS 프로젝트로 `2026-05-28` 의 fix 들이 화면에 반영되는지 확인 (phase 자동 전이, run.status 정확, COPY 컬럼 정합).
15. 보강 데이터(`C:\KSINFO\TestData\samples-augmented\`)를 `samples/csv/` 에 swap 하면 Audit/Verify/Quarantine 시연 가능 (위반 7건).

## 함정 / 결정 이력

- **`ActiveRunState` 타입 inline 이전** — store 에서 제거하고 ExecutionPage 내부 type 으로. RunHeader 도 같은 파일이라 충돌 없음. DashboardPage·ExecutionOverviewPage 는 더 이상 이 타입 안 씀(real DTO 사용).
- **`executionPreflight` persist v6** — `activeRun` / `runCounter` / `selectedSnapshotId` / `preflightResults` 모두 drop. 기존 사용자 sessionStorage 가 호환되도록 migrate 함수에서 정리.
- **G2 정밀도 trade-off** — 7 stage chip 정밀 표시는 BE per-stage metric 이 없어 `progressPct` 균등 분배로 단순화. PoC1 충분, PoC2 에서 정밀화 (ExecutionOverviewService 에 currentStage/stagesCompleted 추가).
- **Artifacts BE wiring 보류** — UI shell + ExcelJS 다운로드 path 완성, mock 데이터만 들어감. 별도 라운드 (~2-3일).
- **Production build dead code** — `npm run build` strict 에러 다수가 mock 제거 무관한 잔재. 별도 cleanup 라운드.

## 안 한 것 (의도적으로)

- Artifacts/SiteExport BE wiring (P2)
- SqlComposer union/join 정밀화 (P0 #1, #2)
- Row-level Quarantine 분리 (P0 #4) — 마이그레이션 주석은 명시했으나 구현 안 됨. 별도 작업 (~1-2일).
- `npm run build` strict 에러 cleanup (P3)
- cutover 라이프사이클(ready → cutover during run, cutover → hypercare on finishRun)
- StageInstance status 잔존 fix (P1 #6)

## 작업 흐름 노트 (방법론)

이 라운드 중간에 "mock 제거 전 real-mode parity 먼저 확인" 절차를 도입했다 (사용자 직접 지시). Audit → 누락 식별(G1/G2) → 누락 fix → mock 제거 → tsc/compile 검증. 권장 패턴 — 다음 큰 cleanup 작업에도 적용.

## 사용자 환경 메모

- 로컬 TO-BE PG: `localhost:5432`, db `insert_test`, user `postgres` (1차 리뷰 검증용).
- 메타 DB: Flyway 자동 처리.
- 보강 데이터: `C:\KSINFO\TestData\samples-augmented\` (repo 밖, SendUserFile 로 사용자에게 전달됨).

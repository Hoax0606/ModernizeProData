# 2026-05-27 — execution-worker-stage-runner (Jiyeong Im)

## 한 일
- **7-stage worker runner 풀 구현** (`coordinator/worker/`) — `LocalWorkerExecutor` (in-process sequential), `StageContext`, `RunOutputPathResolver`, 그리고 `stages/` 의 Check / Extract / Reconcile / Transform / Audit / Load / Verify. mock 아니라 실 DuckDB / CSV / DDL / TO-BE DB 처리.
- **RunService 통합** — AFTER_COMMIT async dispatch (`RunStartedEvent` + `RunExecutionListener` `@TransactionalEventListener + @Async`). UI 는 runId 즉시 받고 stage 는 별 thread 에서 실행.
- **Quarantine 모델** (`coordinator/quarantine/` + `V20260526150000__quarantine_entries.sql`) + `QuarantineController`. `sample_data` JSONB 가 frontend `QuarantineGroup` shape 와 1:1.
- **`TransformStage`** — `mapping_rules` + `mapping_code_maps` + `transform_rule` → DuckDB SQL 생성 (code_domain CASE WHEN 포함).
- **`PgCopyManager`** — TO-BE PostgreSQL COPY FROM stdin.
- **Frontend swap** — `LogViewerPage` / `SiteQuarantinePage` mock → 실 API (`api/quarantine.ts`).
- **dev merge 통합** — UDF 9개 / `WorkerNode` / Frozen snapshot / Flyway fix (팀원).

## 다음 사람이 할 일
- **test 데이터 보충 후 end-to-end 검증** — smoke (runId=`r-a83f9dfb`) 는 7 stage 다 돌지만 CSV 없어서 fail. 필요: TO-BE DDL 7개 (`applicants` 외), CSV 8개 (`sites.csv_path` 폴더), `sites.tobe_db_by_env` config (현재 `tobeEnv='mainframe'` 인데 해당 env config 없음 → Check stage 의 TO-BE DB ping fail).
- **Frontend 화면 검증** — mock 제거 후 LogViewer/SiteQuarantine 이 실 데이터로 렌더되는지 (이번에 화면 확인 못 함).
- `TransformStage` 가 dev 의 UDF (`apply_scale` / `convert_era` 등) 를 `transform_rule` 에서 호출하도록 연동 검증.

## 함정 / 결정 이력
- **Phase 가드 env-based 단순화** — pre-flight 가 frontend 1차 방어라 backend 는 environment 만 검사. `cutover`=prod+phase`ready` 만, `test/rehearsal`=non-prod 모든 phase 허용 (사용자 결정).
- **lock check 완화** — `running`/`paused` 만 LOCKED. `completed` 는 새 run 허용 (frontend mock simulation 이 `completed` 로 남겨 LOCKED 되던 문제 해결).
- **`StageTableResult` unit = binding** — `composition_kind=single` 만. join/union 미구현.
- DuckDB schema 는 run 별 격리 (`"run_{runId}"`).
- `coordinator/worker/` 에 사용자(`WorkerExecutor`/`StageRunner`) + dev(`WorkerNode*`) 의미 다른 두 모듈 공존 — 추후 패키지 분리 검토.

## 안 한 것 (의도적으로)
- **architecture 다이어그램 vs 현재 구현 갭 = PoC 2차**: Source Reader SPI 다중 포맷 (CSV 만, EBCDIC/COBOL/Excel X), Loader Adapter SPI (PostgreSQL 만), phase별 CP2 분기, 청크 streaming, 병렬 처리, Quarantine parquet 격리 파일, AS-IS DB N일 보존.
- TaskExecutor bean 명시 (`@Bean("taskExecutor")`) — 현재 SimpleAsyncTaskExecutor warning, 동작엔 영향 X.

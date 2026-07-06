# 2026-06-04 — abort-accuracy-bundle (jiyeong)

## 한 일

- **Abort 정확성** — `RunCancelledException` + `StageContext.throwIfCancelled()` 도입, 8 stage runner (Audit/Check/Extract/Load/Reconcile/Transform/Verify/Validation) 의 binding loop / sub-step 에 cancel 체크 추가. `LocalWorkerExecutor` 가 cancel 신호 시 진행 중 stage 를 `failed` 로 마킹 + running 상태로 남은 `stage_table_results` 정리. cancel 시 `IllegalStateException` 안 던져 spurious ERROR 로그 방지.
- **Run history pending 분류** — `RunTableResultsService` 가 `stages.size()` vs 처리된 result 수 비교해 abort 시 미실행 stage 가 있는 binding 을 `pending` 분류. Run history 일람의 "abort 했는데 1 success" 거짓 표시 해소. FE `LogViewerPage` 에 회색 dot pending badge + drill-down `queued` 라벨.
- **Pipeline UI polish** — `StatusBadge` tone 명명 swap 정리 (running=navy, warn=amber 시각 구분), Pipeline 박스 배경 / Overall progress fill 톤 통일, `ProgressBar` success/failed segments 분할, stage tile 에 per-stage wall-clock elapsed.
- **Checksum no-PK** — `ValidationReportService` 의 `duckChecksumRaw == null` case verdict `WARN` → `PASS` + note. Overview / Quarantine 비대칭 해소 (backlog).
- **Quarantine skip 탭** — `SiteQuarantinePage` 에 ack 된 WARN 분리 카운트.

## 다음 사람이 할 일

- 일본 금융권 첫 현장 시나리오에서 abort/timeout 시 stage_table_results 의 status 가 운영자 audit 기대와 일치하는지 검증 (특히 mid-stage cancel).
- `validate.checksum` 의 no-PK PASS + note 가 일본 금융권 감사 증빙에서 충분한지 확인 (PASS 면 quarantine entry 없어 ack 불필요).

## 함정 / 결정 이력

- Pipeline "2 success" vs Run history "1 success" 불일치는 디스플레이 버그가 아니라 **관점 차이** (stage 진척 vs binding 완료도). fix 후 Pipeline 은 stage 단위 그대로, Run history 만 binding 단위 `pending` 분류.
- `ValidationReportService.java` 가 abort 의 throwIfCancelled hunk 와 checksum verdict hunk 양쪽 보유. 거리 700줄 이상이라 textual conflict 없음.
- Cancel 시 `IllegalStateException` 안 던지는 이유: `RunService.abortRun` 이 이미 `finishRun` 으로 `aborted` 처리했음. listener 가 ERROR 로깅 + `failRun` 시도하면 `isTerminal` 가드로 no-op 이지만 spurious ERROR 로그 발생.
- (D) sub-step cancel 체크는 디스크 IO / 대용량 SQL 직전에 배치 — Extract 의 CREATE TABLE AS SELECT read_csv_auto, Load 의 PG COPY, Transform 의 transform SQL, Verify 의 PK 정렬 전수 비교, Validation 의 6 검증.

## 안 한 것 (의도적으로)

- Transform row-level isolation — `transform-fail-fast` 정책 유지 (금융권 strict 정합성).
- Pipeline 의 stage 단위 표시 변경 — Run history 만 binding 단위 보정. 두 관점 공존.
- `SchedulerPage` 의 Tables 칼럼에 pending badge 추가 — LogViewer 와 같은 화면 (memory 확인 후) 이라 별도 작업 불필요.

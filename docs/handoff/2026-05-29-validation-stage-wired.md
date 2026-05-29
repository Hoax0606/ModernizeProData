# 2026-05-29 — validation-stage-wired (jiyeong)

Artifacts 의 Validation 카테고리를 100% mock 에서 real BE 로 교체 + Validation 을
**8 번째 pipeline stage** 로 승격. 일본 금융권 잔액·거래액 SUM 일치 감사 증빙물 생성.

## 한 일

- **BE 신규**: `coordinator/run/validation/` 패키지 — `ValidationReport` entity, repo,
  `ValidationReportService` (StageRunner 구현), DTO. `coordinator/api/ValidationReportController`
  3 endpoints (listByRun / getByBinding / getByTable).
- **Flyway**: `V20260530100000__validation_reports.sql` (테이블) + `V20260530110000__stage_instances_allow_validation.sql`
  (CHECK constraint 에 `'validation'` 허용).
- **StageCatalog**: TEST/CUTOVER 둘 다 `validation` 8 번째 stage 로 추가. Verify 직후.
- **LocalWorkerExecutor**: `NON_BLOCKING_STAGES = {"validation"}` — validation fail 이
  run.status 에 영향 안 가도록. Pipeline tile 만 빨간색으로 표시.
- **RunExecutionListener**: 한때 추가했던 post-execute hook 제거 (이제 stage 로 실행됨).
- **FE 신규**: `frontend/src/api/validation.ts` (3 methods + 7 type interfaces).
- **FE 수정**: `ArtifactsPage.tsx` — `MOCK_ROWS_BY_TABLE.validation` 194 라인 + `VALIDATION_CHECK_COUNT`
  삭제. `Min Max` 시트 신규 추가 (5 시트). DTO → Cell[][] 변환 함수 5 개. `validationByTable`
  prefetch state. ExcelJS download / zip bundle 도 실 데이터 기반.
- **FE 수정**: `pipelineStages.ts` BASE_STAGES 에 8 번째 `validation` tile.

## 다음 사람이 할 일

- **Pull 후 SUM(VARCHAR) fix 확인**: BANKSYS run 돌리면 `Validation failed banksys.accounts:
  ... Binder Error: No function matches sum(VARCHAR)` 가 발생 중. DuckDB tobe_accounts
  의 customer_id 가 TO-BE DDL 상 BIGINT 인데 실제로는 VARCHAR 로 저장돼서 발생.
  다른 팀원이 TransformStage 측 (정타입 cast 보장) 으로 fix 중 — pull 받은 후
  ValidationReportService 가 잘 맞물리는지 BANKSYS run 으로 확인.
- **BE 재기동 + Flyway 적용**: V20260530100000 + V20260530110000 두 migration 이
  적용되는지 기동 로그에서 확인.
- **Pipeline 8 tile 확인**: 새 run 에 validation tile (8th) 표시되는지. PASS 면 초록.
- **Artifacts Validation 검증**: 5 시트 (Overview / Sum recon / NULL parity / Min Max /
  Range) 표시. 일본 금융권 SUM 일치 라벨링. ExcelJS download → 시각적 mock 와 동일.

## 함정 / 결정 이력

- **Validation = post-processing vs 정식 stage 의 갈림길**: 처음 V-1~V-6 라운드는
  post-processing 으로 갔다가, 사용자가 "log viewer 에 에러가 보이는데 pipeline 에는
  안 표시" 라고 신고. V-7 라운드에서 stage 화. Stage = 신호 surface 가 자연스러움.
- **Non-blocking stage 패턴 신설**: validation fail 이 run.status=failed 로 cascade
  하면 audit-style 운영이 깨짐 (정보성 보고서가 run 을 죽임). `NON_BLOCKING_STAGES`
  화이트리스트로 분리 — pipeline UI 는 빨간 tile, but run 통과.
- **Quarantine 불사용**: Validation 은 aggregate 보고서, AuditStage 만 row-level
  violation = quarantine. 둘의 audit trail 명확히 분리.
- **`stage_key` CHECK constraint 갱신**: 단순히 enum 한 줄 추가 — 옛 run (7 stage)
  은 stage_instances 에 7 row, 새 run 은 8 row. FE 는 누락 stage 를 idle 회색으로 표시.
- **SUM(VARCHAR) Binder Error**: 임시로 ValidationReportService 에 `TRY_CAST` 추가
  했으나 사용자가 "다른 팀원이 근본 fix 중 — 원복" 요청해서 revert. 팀원 fix 의
  scope (Transform / SqlComposer / 어디?) 는 pull 후 확인.

## 안 한 것 (의도적으로)

- **SiteExportPage validation zip**: ArtifactsPage 만 wired. site export 4 카테고리
  zip 의 Validation placeholder.txt 은 그대로 — 별 라운드. [[project_artifacts_be_wiring_missing]].
- **TransformStage 정타입 cast**: 팀원 담당 — 이 라운드 범위 외.
- **typeValid 시트의 실 데이터**: AuditStage `validate.range` 결과를
  ValidationReport.typeValid 에 합치는 작업은 후속 (현재 빈 배열).
- **대용량 environment**: BANKSYS 데모 (수십 row) 기준. 수백만 row 환경의 SUM/MIN/MAX
  쿼리 N-pass 최적화는 PoC2 (한 쿼리에 `SELECT SUM(c1), SUM(c2), ...` 묶기).
- **DuckDB / PG numeric / timestamp 포맷 차이로 인한 false FAIL**: BigDecimal 비교로
  numeric 은 OK, but timestamp `::text` 포맷 (TZ / 정밀도) 차이는 잠재. 시연 데이터에는
  영향 없는 것으로 보고 PoC1 통과.

## 변경 파일 일람 (commit reference)

```
신규 BE (5):
  coordinator/run/validation/ValidationReport.java
  coordinator/run/validation/ValidationReportRepository.java
  coordinator/run/validation/ValidationReportService.java
  coordinator/run/validation/ValidationReportDto.java
  coordinator/api/ValidationReportController.java

신규 Flyway (2):
  db/migration/V20260530100000__validation_reports.sql
  db/migration/V20260530110000__stage_instances_allow_validation.sql

수정 BE (3):
  coordinator/run/RunExecutionListener.java   (hook 추가 후 stage 화로 다시 제거)
  coordinator/run/stage/StageCatalog.java     (validation 8 번째 추가)
  coordinator/worker/LocalWorkerExecutor.java (NON_BLOCKING_STAGES)

신규 FE (1):
  frontend/src/api/validation.ts

수정 FE (2):
  frontend/src/pages/ArtifactsPage.tsx        (mock 제거 + DTO→Cell[][] 변환)
  frontend/src/lib/pipelineStages.ts          (BASE_STAGES 8 개)
```

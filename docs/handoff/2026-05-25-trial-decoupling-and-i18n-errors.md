# 2026-05-25 — trial-decoupling-and-i18n-errors (Suhyun Jin)

오전의 칩/임포트 버튼 작업(`2026-05-25-mapping-chip-and-import-restyle.md`)에 이어, Trial 동작 정리 + Report 에러 i18n 화.

## 한 일

- **Trial 동작 분리**: `startTest` / `useEffect` 에서 `projectApi.update({ phase: 'test', runStatus: ... })` 호출 전부 제거. Trial 은 DuckDB 위 in-memory 미리보기라 project phase 를 건드릴 이유가 없음. `projectApi` import 도 삭제.
- **TO-BE DB 연결 체크 제거**: Trial 비활성화 조건에서 `!tobeDbConnected` 제외. 관련 `activeSite` / `tobeDb` / `tobeDbConnected` 정의 + 상단 status counts 의 `TO-BE DB not configured →` 배너 모두 삭제. (Trial 이 TO-BE 적재를 안 하므로 DB 연결이 무관.)
- **Report 에러 위치 이동**: 필터바 아래 배너 → `<tbody>` 첫 행 (colSpan, 헤더 바로 밑) 으로. 에러 시 데이터 행은 렌더 안 됨.
- **백엔드 에러 메시지 친절화 + 구조화**: `MappingReportService.identifyFailingRule` 이 컬럼별 probe (`SELECT (expr) FROM ... LIMIT 0`) 로 실패 expression 식별. `ReportResult` 에 `errorKind` / `errorColumn` / `errorExpression` / `errorType` 4 필드 추가, raw DuckDB 메시지는 log.warn 으로만 남기고 화면에서 제거.
- **에러 i18n 화**: `mapping.report.error.*` 키 13 개 (ko/ja/en) 추가. `buildReportErrorMessage(report, t)` 헬퍼가 `errorKind` 별로 메시지 합성 — 사용자 언어 자동 반영.

## 다음 사람이 할 일

- **백엔드 재기동 필요** — `ReportResult` 레코드 필드가 늘어 직렬화 schema 가 바뀜.
- **스냅샷 schema 설계** 시 `mapping_rules` 외에 `mapping_code_maps` + `mapping_table_binding(s)` 까지 함께 동결해야 Report 결과 재현 가능. `id` / `project_id` 는 스냅샷 row 에선 제외, `import_id` 는 정책 결정.
- legacy `error` 필드 (한국어 fallback) 는 i18n 정착 후 제거 가능.

## 함정 / 결정 이력

- **`error` 필드를 안 지운 이유**: record 호환성. 클라이언트가 새 i18n 키를 못 받았을 때 fallback 으로 노출. i18n 키 누락 시 키 문자열 그대로 화면에 노출되는 게 더 위험.
- **probe 실패 시 raw 메시지를 화면에 안 띄우는 이유**: PoC 사용자에게 DuckDB 원문은 의미 없음. log.warn 으로만 남기고 화면은 분류 라벨만 — 디버깅은 backend 콘솔.

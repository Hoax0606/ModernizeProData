# 2026-05-25 — report-error-hint-and-payroll-scenario (Suhyun Jin)

오전의 multi-source combine 작업 (`2026-05-25-mapping-rules-array-and-combine.md`) 직후. Report 에러 진단을 row-level 까지 강화 + DuckDB SQL 변환 풀세트 시나리오 추가.

## 한 일

- **`MappingReportService.identifyFailingRule` probe 강화**: `LIMIT 0` → `LIMIT 20` 으로 변경, `rs.next()` 끝까지 흘려서 row-level conversion error (예: `STRPTIME` 포맷 불일치) 도 잡힘. 이제 "어느 컬럼" 까지 식별 가능.
- **`ReportResult.errorHint` 필드 신설**: DuckDB raw 메시지에서 첫 줄만 추출 (`Could not parse string "2024/03/31" according to format specifier "%Y-%m-%d"` 같은 결정적 힌트). `extractHint` 헬퍼가 `{Type} Error:` prefix 제거 + 200자 캡.
- **FE i18n `mapping.report.error.hintLabel`** 추가 (ko/ja/en — `힌트` / `ヒント` / `Hint`). `buildReportErrorMessage` 가 hint 라인을 메시지 끝에 합성.
- **에러 박스 selectable + Copy 버튼**: `userSelect: 'text'` + `cursor: 'text'` 적용, 우상단에 클립보드 복사 버튼.
- **샘플 시나리오 추가** — `HR_PAYROLL.EMPLOYEES` → `public.employees_payroll` (`payroll_oracle.sql` / `payroll_postgres.sql` / `HR_PAYROLL.EMPLOYEES.csv`): DuckDB SQL 로 처리 가능한 변환 패턴 풀세트 (CAST / STRPTIME / CASE / TRIM / LPAD / SUBSTR / REPLACE / 산술 / NULLIF / COALESCE / passthrough). `column_mapping.csv` 16 행 + `mapping_definition.md` 3.5절 추가.

## 다음 사람이 할 일

- **PG 키워드 / 내장 함수 풀세트 시드** — 현재 `SQL_KW` / `SQL_FUNCS` 가 60+50 개 수준. 현장에서는 소스 수정 불가하므로, 메타 DB 의 `sql_functions` 테이블 도입 + UI 에서 UDF 추가 가능하도록 후속 작업 권장 (대화 정리 있음).
- **`tryStringToDateSql` 의 length-only 추정 한계** — `VARCHAR(10)` 이면 무조건 `%Y-%m-%d` 생성. CSV 가 `2024/03/31` 같이 슬래시면 사용자가 row editor 에서 수동 수정 필요. `column_mapping.csv` 의 `notes` 컬럼 또는 별도 hint 컬럼에서 변환식 읽도록 개선 여지.
- **샘플 CSV 빈값 처리** — 일부 NULL 가능 컬럼이 빈 문자열로 들어와 `STRPTIME` / `CAST` 실패. 정의서엔 `NULLIF(...,'')` 로 감싸도록 안내. row editor 에서 직접.

## 함정 / 결정 이력

- Probe 비용: 컬럼 N개 × 20행 = 보통 < 100ms. 비용 대비 진단 가치 압도적.
- `extractHint` 가 raw 영문 메시지 그대로 노출 — i18n 화 비용 대비 정보 손실 위험. 현재 그대로 표시.
- 샘플 CSV `2001-02-29` → `2000-02-29` 수정. 2001 은 윤년 아님 (4 로 나뉘지만 100 으로 나뉘고 400 으론 안 나뉨).

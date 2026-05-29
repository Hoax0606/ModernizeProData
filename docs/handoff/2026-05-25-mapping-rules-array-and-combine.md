# 2026-05-25 — mapping-rules-array-and-combine (Suhyun Jin)

다중 source (combine 케이스 — 예: BIRTH_YEAR/MONTH/DAY → birth_date) 를 정규 schema 로 지원.

## 한 일

- **DB: `mapping_rules.asis_column` / `asis_type` 을 `TEXT[]` 로** (`V20260525174721`). 직전 마이그레이션의 `;` 묶음 VARCHAR 를 `string_to_array(...)` 로 자동 배열 변환.
- **`MappingRule` 엔티티 `String[]`** + `@JdbcTypeCode(SqlTypes.ARRAY)`. **`List<String>` 시도는 실패** — Hibernate 6.6 PG dialect 가 List 를 jsonb 으로 매핑.
- **`MappingImportService`**: RuleRow / 파서 / `buildAliasMaps` / `UpsertRuleRequest` 모두 `String[]` 대응. `splitSemicolon` + `appendArray` 헬퍼 추가. CSV 입력은 **행분할 + 셀결합 흉내** 와 **한 셀 `;` 묶음** 둘 다 받아 배열로 정규화. 자동 transform 생성은 source 가 1개일 때만.
- **`MappingReportService`**: `buildTypesClause` 가 배열 index 매칭. `resolveCsvFile` 가 `{schema}.{table}.csv` 우선, `{table}.csv` fallback — `RECRUIT.APPLICANTS.csv` 같은 파일명도 매칭.
- **Frontend**: `MappingRuleDto.asisColumn` / `asisType` `string[] | null`. hydrate / save 모두 배열 그대로. Inspector 의 자동 CAST 가 multi-source 시 **`-- combine: 변환식을 직접 입력하세요 (예: MAKE_DATE / CONCAT)`** 주석. `transformPreview` placeholder 도 동일 톤. 사용자 입력은 `prevAutoCastRef` 비교로 보존.
- **SQL syntax**: 키워드(주황)와 함수(옅은 yellow) 색 분리. `SQL_FUNC_SIGS` 50+ 시그니처 정의 — 자동완성 선택 시 `MAKE_DATE(` 까지 자동 삽입 + 커서 괄호 안 위치, 드롭다운에 `(year, month, day)` hint 표시.

## 다음 사람이 할 일

- **DBeaver 표시 깨짐** — `asis_column` 컬럼이 "Array type varchar doesn't have a component type" 으로 보임. psql 에선 정상. JDBC 드라이버 업데이트 또는 `array_to_string` view 우회.
- `UpsertRuleRequest` 에 `asisType` 필드 없음 — row editor 에서 source 컬럼 추가/변경해도 asis_type 은 임포트 시점 값 그대로. multi-source 시나리오에선 별 문제 없지만 형식상 추가 권장.

## 함정 / 결정 이력

- `@JdbcTypeCode(SqlTypes.ARRAY)` 가 `List<String>` 에는 jsonb 으로 매핑됨. `String[]` 만 PG `_text` 로 정확히 매핑. `hibernate.type.preferred_array_jdbc_type=ARRAY` 옵션은 incubating warning 만 뜨고 효과 없음.
- 자동 transform 생성을 multi-source 시 skip 한 이유: 결합 식 (MAKE_DATE / `||` / CASE) 은 사용자가 도메인 지식으로 결정. 추측해서 `CAST(first_col AS DATE)` 식으로 만들면 오히려 디버깅 방해.

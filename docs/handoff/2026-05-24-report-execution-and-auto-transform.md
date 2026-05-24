# 2026-05-24 — report-execution-and-auto-transform (Suhyun Jin)

`2026-05-24-mapping-bindings-and-row-edits.md` 이후. Report 화면이 실제 SQL 을 DuckDB 로 돌리고, 매핑정의서 임포트가 transform_sql 자동 생성 (CAST + code_map CASE) 까지 처리하도록 확장. 사이트 vs 프로젝트 단위 분리 컨셉 정립 — 검증 방향도 바로잡음.

## What was done

### 1) Report SQL 실행 — `MappingReportService`

- 신규 `MappingReportService.runReport(projectId, tobeSchema, tobeTable, limit)` — 한 TO-BE 테이블의 룰 + 바인딩으로 `SELECT` 한 방 생성 후 DuckDB 실행
- 신규 `GET /api/v1/projects/{id}/mapping/report?tobeSchema=&tobeTable=&limit=20`
- 응답: `{ headers, rows, rowCount, truncated, sql, error }` — `sql` 도 같이 돌려줘서 디버깅
- 프론트 `useReportRows` hook 으로 교체, 셀 lookup 은 `r.tgt` (TO-BE 컬럼명) 기준 — backend 가 이미 그렇게 alias 함
- 모달 안 loading / amber warning / red error 배너 인라인 표시 (오류 SQL 도 같이)

핵심 SQL 패턴:
```sql
SELECT
  TRY((c.CUST_ID)) AS "customer_id",
  TRY((CASE c.GENDER WHEN 'M' THEN 'MALE' WHEN 'F' THEN 'FEMALE' WHEN 'U' THEN 'UNKNOWN' END)) AS "gender",
  ...
FROM read_csv('{csvPath}/customers.csv', header=true, delim=',',
              null_padding=true,
              types={'CUST_ID': 'BIGINT', 'ADDR_ZIP': 'VARCHAR', ...}) "c"
LEFT JOIN read_csv(...) "a" ON c.CUST_ID = a.CUST_ID
WHERE ...
LIMIT 20
```

### 2) `mapping_rules.asis_type` 컬럼 — read_csv `types=` 절

- 신규 `V20260524144918__mapping_rules_asis_type.sql`
- CSV 의 `asis_type` 컬럼 읽어 저장 (`VARCHAR2(7)`, `NUMBER(15)` 등)
- Report SQL 생성 시 컬럼별 타입을 `types={'COL': 'TYPE', ...}` 로 DuckDB 에 넘김 → 자동 추론 오버라이드
- 케이스: ADDR_ZIP 값이 전부 숫자라 자동 추론은 BIGINT 인데 의도는 VARCHAR (SUBSTR 동작해야 함) → `types` 명시로 해결

Oracle → DuckDB 타입 매핑 (`oracleToDuckDbType`):
- `NUMBER(p,s)` s>0 → `DECIMAL(p,s)`, s=0 → `BIGINT`
- `VARCHAR2`/`CHAR`/`CLOB`/`NVARCHAR` → `VARCHAR`
- `DATE` → `TIMESTAMP` (Oracle DATE 는 시간 포함)
- `TIMESTAMP WITH TIME ZONE` → `TIMESTAMPTZ`
- `BLOB`/`RAW` → `BLOB`

### 3) `TRY_CAST` 자동 치환

DuckDB 1.1.3 에 `TRY(...)` 함수 wrapper 가 없어서, 다음 정규식으로 caller 가 작성한 CAST 를 안전한 TRY_CAST 로 치환:

```java
expr.replaceAll("(?i)\\bCAST\\s*\\(", "TRY_CAST(");
```

효과:
- `CAST(BIRTH_DT AS BIGINT)` (TIMESTAMP→BIGINT 불가능) → `TRY_CAST(BIRTH_DT AS BIGINT)` → 그 셀만 NULL, SELECT 전체는 계속
- 의도된 cast (e.g. `CAST(c.CUST_ID AS VARCHAR)`) 도 동일하게 작동

### 4) Simplified CSV 포맷 — strategy / rule_sql 컬럼 제거

이전 CSV: `asis_table,asis_column,asis_type,tobe_table,tobe_column,tobe_type,strategy,rule_sql,default_value,notes`

새 CSV: `asis_table,asis_column,asis_type,tobe_table,tobe_column,tobe_type,code_domain,default_value,notes`

**`strategy` 자동 추론** (`applyStrategy` 의 새 분기):
- `asis_column` 있음 → `expression`
- 없고 `default_value` 있음 → `default`
- 둘 다 없음 → `null`
- (호환: CSV 에 `strategy` 컬럼 있으면 그대로 사용)

**`transform_sql` 자동 생성** — alias 자동 할당 (`buildAliasMaps`) 후 expression 룰에 대해:
1. `code_domain` 명시 + 해당 domain 의 code_maps 존재 → `CASE WHEN ... END` 자동 생성 (`buildCaseFromCodeMap`)
2. 그 외 — asis_type vs tobe_type **카테고리 동일** → passthrough `{alias}.{column}`
3. 카테고리 다름 → `CAST({alias}.{column} AS {tobe_type})`

타입 카테고리 (`typeCategory`): string / integer / decimal / boolean / date / timestamp / timestamptz / binary.

### 5) `mapping_rules.code_domain` 컬럼 + 코드맵 CASE 자동 생성

- 신규 `V20260524173031__mapping_rules_code_domain.sql`
- column_mapping CSV 에 `code_domain` 컬럼 추가 (선택적)
- 임포트 처리 순서 변경: **code → column** (column 의 CASE 생성 시 code 룩업 필요)
- `buildCaseFromCodeMap` 빌더: `CASE src WHEN 'A' THEN 'active' WHEN 'B' THEN 'pending' END`. target_value 가 `TRUE`/`FALSE`/`NULL` 키워드면 unquoted (boolean / null literal), 그 외엔 single-quoted string.

예시:
```
asis_column=GENDER_CD, tobe_column=gender, code_domain=GENDER
↓ 자동 생성
CASE c.GENDER_CD WHEN 'M' THEN 'MALE' WHEN 'F' THEN 'FEMALE' WHEN 'U' THEN 'UNKNOWN' END
```

```
asis_column=DEL_FLG, tobe_column=is_deleted, code_domain=YN_BOOL
↓ (target_value 가 TRUE/FALSE 이므로 boolean literal)
CASE c.DEL_FLG WHEN 'Y' THEN TRUE WHEN 'N' THEN FALSE END
```

### 6) 검증 방향 수정 — DDL ⊆ 맵핑정의서

**컨셉 정립**:
- **Site 단위**: AS-IS CSV (csvPath) + 맵핑정의서 (column_mapping + code_mapping) — 사이트 전체의 슈퍼셋
- **Project 단위**: 그 프로젝트가 담당하는 TO-BE 테이블의 DDL — 부분집합

검증 방향이 거꾸로였음:
- ❌ (이전) 맵핑정의서의 TO-BE 테이블이 DDL 에 있는지 — 다른 프로젝트용 룰까지 매번 경고
- ✅ (이후) DDL 의 컬럼이 맵핑정의서에 명세되어 있는지 — 이 프로젝트가 채워야 할 컬럼인데 룰이 없으면 경고

신규 `findUncoveredDdlColumns(projectId)`:
```ts
// mapping_rules 의 (schema, table) → Set<column> 맵 구축
// TOBE_TABLES × MAPPING_BY_TOBE 순회 → 룰에 없는 DDL 컬럼 수집
// 반환: ["banksys.customers.legacy_col", ...]
```

Apply 시 amber 경고 메시지:
> 현재 프로젝트 TO-BE DDL 의 다음 컬럼이 맵핑정의서에 명세되어 있지 않습니다: X. 맵핑정의서를 보완하세요.

`hydrateBindingsFromDb` 는 binding hydrate 만 담당, 검증은 분리.

### 7) Sample/template 정리

`frontend/public/templates/` — 다운로드용 빈 헤더만:
- `mapping_definition_template.csv` (`asis_table,...,code_domain,default_value,notes`)
- `code_mapping_template.csv` (`domain,source_value,target_value,description`)

`/Users/Jinjinzara/Sample/` — 시나리오별:
- `ddl/3tables_oracle.sql` + `ddl/3tables_postgres.sql` (BANKSYS 3 테이블 프로젝트)
- `ddl/codemaster_oracle.sql` + `ddl/codemaster_postgres.sql` (HR.M_EMPLOYEE 프로젝트)
- `csv/customers.csv` + `accounts.csv` + `transactions.csv` + `m_employee.csv` (사이트 전체 AS-IS)
- `mapping/column_mapping.csv` + `code_mapping.csv` (사이트 전체 맵핑정의서 — 두 시나리오 모두 커버, 50 row)

`column_mapping.csv` 의 `code_domain` 활용 예시: gender(GENDER) / is_deleted(YN_BOOL) / account_type(ACCT_TYPE) / status(ACCT_STATUS / EMP_STATUS) / transaction_type(TXN_TYPE) / channel(CHANNEL).

### 8) UI label 수정

- 모달 Save → Apply (항상 활성)
- 그리드 헤더: Test → Trial, Testing → Running
- 모달 안 inline 경고: amber 박스에 미커버 컬럼 목록 + "맵핑정의서를 보완하세요"

## Files touched

### 신규 (backend)
- `db/migration/V20260524002919__mapping_rules_transform_sql.sql` (이전 round)
- `db/migration/V20260524023425__mapping_imports_csv_content.sql` (이전 round)
- `db/migration/V20260524144918__mapping_rules_asis_type.sql`
- `db/migration/V20260524173031__mapping_rules_code_domain.sql`
- `coordinator/mapping/MappingReportService.java`

### 수정 (backend)
- `MappingRule.java` — `transformSql`, `asisType`, `codeDomain` 필드
- `MappingImportService.java`:
  - `RuleRow.tobeType` / `codeDomain` / `asisType`
  - `applyStrategy` — strategy 자동 추론 (asis/default presence)
  - 신규 `buildAliasMaps` — (tobe_table → asis_table → alias)
  - 신규 `typeCategory` / `typeCategoriesMatch` / `oracleToDuckDbType`
  - 신규 `buildCaseFromCodeMap` / `formatTargetLiteral` / `sqlEscape`
  - 임포트 처리 순서 swap (code → column)
  - 자동 transform_sql 생성 (passthrough / CAST / CASE)
- `MappingImportController.java` — report 엔드포인트 추가
- `csv-preview` 와 report 의 `read_csv` 호출에서 `types=` 명시

### 신규 / 수정 (frontend)
- `src/pages/MappingPage.tsx`:
  - `MappingReportResult` 타입, `useReportRows` hook
  - ReportView 가 `useTableCsv` → `useReportRows` 로 교체
  - 셀 lookup 을 `r.tgt` (TO-BE 컬럼명) 기준으로
  - 신규 `findUncoveredDdlColumns` — DDL ⊆ 룰 검증
  - `hydrateBindingsFromDb` 시그니처 변경 (void 반환), 검증 분리
  - 경고 메시지 wording 수정
  - amber warning 박스에 SQL / error 표시
- `src/api/mappingImport.ts` — `runReport` API + `MappingReportResult` 타입

### 신규 / 수정 (data / templates)
- `frontend/public/templates/{mapping_definition,code_mapping}_template.csv` — 헤더만
- (제거) `frontend/public/templates/{mapping_definition,code_mapping}_sample.csv` — sample 폴더로 분리
- `/Users/Jinjinzara/Sample/ddl/{3tables,codemaster}_{oracle,postgres}.sql`
- `/Users/Jinjinzara/Sample/csv/m_employee.csv` (신규)
- `/Users/Jinjinzara/Sample/mapping/column_mapping.csv` — 두 시나리오 통합, code_domain 활용
- `/Users/Jinjinzara/Sample/mapping/code_mapping.csv` — 7 domains

## Open items / known limits

- **type system 은 카테고리 매칭만** — `NUMBER(15)` ↔ `BIGINT` 는 같은 'integer' 카테고리라 passthrough. `NUMBER(18,2)` ↔ `NUMERIC(18,2)` 는 같은 'decimal' 카테고리지만 정밀도 자체 검증은 안 함. 운영에서 정밀도 손실 가능.
- **자동 CASE 의 ELSE 없음** — code_map 에 정의 안 된 source_value 만나면 결과 NULL. 명시적 ELSE 필요하면 row editor 에서 수동 보완.
- **UNION composition 미지원** — JOIN 만 지원. union 은 SELECT 자체가 달라지므로 PoC 에선 첫 source 만 사용 + WARN 로그.
- **AT TIME ZONE 등 PG-specific 함수** — 대부분 DuckDB 가 지원하지만 모든 PG 함수는 아님. 실패 시 amber error 로 표시.
- **DDL ⊆ 매핑정의서 검증은 컬럼명 일치만** — 타입 호환성 검증은 아직. NUMBER → VARCHAR 같은 비호환 케이스도 검증 못 함.
- **i18n 미완** — 모달 hint / amber 경고 / 툴팁 같은 새 UI 텍스트가 한국어로 하드코딩됨. ja/en 사용자도 한국어로 보임. 다음 라운드 별도 task 로.

## Verification

1. 백엔드 재기동 → Flyway 가 새 migration 4개 적용
2. Mapping page → Auto-mapping 모달 → simplified CSV (without strategy/rule_sql, with code_domain) 임포트
3. DB 확인:
   ```sql
   SELECT tobe_column, code_domain, transform_sql FROM mapping_rules
   WHERE rule_origin='imported' AND tobe_table='customers' LIMIT 5;
   ```
   - `gender` row 의 transform_sql 이 `CASE c.GENDER WHEN 'M' THEN 'MALE' ... END`
   - `is_deleted` row 가 `CASE c.DEL_FLG WHEN 'Y' THEN TRUE WHEN 'N' THEN FALSE END`
4. Report 화면 → 변환된 row 표시 (MALE/FEMALE/UNKNOWN, true/false, NNN-NNNN 등)
5. DDL 의 컬럼이 맵핑정의서에 없으면 (e.g. DDL 추가했는데 매핑정의서 안 갱신) Apply 시 amber 경고 — 이전 (TO-BE table 미존재) 가 아니라 컬럼 단위 미커버 메시지

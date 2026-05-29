# 2026-05-26 — duckdb-udf-bundle (Suhyun Jin)

DuckDB JDBC 를 1.5 로 올리고 번들 UDF 8 종 + 자동완성 통합. Notion 「変換構造」 §3·4 의 Java UDF 케이스를 PoC 에서 호출 가능하게 만든 첫 단계.

## 한 일

- **DuckDB JDBC 업그레이드** — `duckdb_jdbc 1.1.3 → 1.5.3.0`. UDF API (`DuckDBFunctions.scalarFunction()` 빌더, `withVolatile()`, `withNullInNullOut()`) 가 1.5.2.0 부터 도입돼 그 전 버전엔 등록 자체 불가. smoke test `v1.5.3` 통과.
- **UDF 패키지 신설** — `backend/.../common/duckdb/udf/`. `UdfRegistry` + 8 개 UDF 클래스 (`ApplyScaleUdf`, `ConvertEraUdf`, `AssignSeqUdf`, `UnpackZoneDecimalUdf`, `ValidateBiznoUdf`, `MaskPhoneUdf`, `HashSha256Udf`, `NormalizeCorpUdf`). 함수당 1 파일 — Notion 의 "Unix 철학 (단일 책임)" + 향후 카테고리별 40+ 확장 대비.
- **`DuckDbService.getConnection()` 에 등록 hook** — 새 connection 마다 `UdfRegistry.registerAll()`. 현재 single persistent connection 이라 1 회.
- **공통 정책 일관** — 모든 UDF 가 `withNullInNullOut()` + try/catch null 반환 (예외 throw 금지 → Quarantine 분기). `assign_seq` 만 `withVolatile()` (호출마다 다른 값).
- **`apply_scale` 반환 타입 VARCHAR** — 동적 scale 인자에 대해 generic BigDecimal 반환 시 DECIMAL(38, 11) trailing zero 가 붙음. VARCHAR 로 두고 사용자가 row editor 에서 `CAST(... AS DECIMAL/INTEGER)` 명시.
- **Frontend 자동완성** — `MappingPage.tsx` 에 `UDF_FUNC_SIGS` + `UDF_FUNCS` Set + `_udf` 색 (보라 `#c8a3ff`). PG 빌트인 (옅은 노랑) 과 시각적 구분. `applyAc` / `localCompletions` / `highlightSql` / `upperSqlKeywords` 모두 `SQL_FUNC_SIGS ?? UDF_FUNC_SIGS` 패턴으로 두 map lookup.
- **Notion `UDF.java` 페이지** 업데이트 — 개요 표 + 각 함수 상세 + 등록 흐름 + 신규 UDF 추가 패턴.

## 다음 사람이 할 일

- **시연용 sample 시나리오 추가** — `samples/csv/` 에 COMP-3 hex / 일본 연호 / 法人番号 / 전화번호 컬럼 포함한 시나리오. `mapping_definition.md` 에 UDF 케이스 섹션 (§3.6 등).
- **추가 UDF** — Notion 「変換構造」 §4 후속 후보 (`gen_uuid_v7`, `lookup_region`, `julian_to_date`, `mask_account` 등). 패턴 일정 — 새 클래스 + Registry 한 줄 + FE `UDF_FUNC_SIGS` 한 줄.
- **`assign_seq` 의 카운터 영속화** — 현재 프로세스 메모리 (`ConcurrentHashMap`). JVM 재기동 시 reset. 본격 운영 단계엔 메타DB 시퀀스 테이블로 이전.

## 함정 / 결정 이력

- 처음엔 `duckdb_jdbc 1.1.3` 유지하려 했지만 `org.duckdb.DuckDBConnection` 에 UDF 등록 메서드 자체가 없음. 1.5.2.0 첫 도입 — 우회 (CREATE MACRO, Java preprocessing) 는 COMP-3 같은 바이트 연산 시연 불가능해서 정공법으로 업그레이드.
- `Hibernate 6.6` + PG 와의 호환은 검증 완료 (Flyway 30 migrations 정상, EntityManagerFactory 초기화 OK, RECRUIT/HR_PAYROLL 시나리오 회귀 없음).
- 함수당 1 클래스 vs 단일 `BundledUdfs.java` — 사용자가 "계속 늘릴 계획" 이라 분리 유지. 10+ 가 되면 카테고리 패키지 (`udf/numeric/`, `udf/date/`) 로 분리 권장.

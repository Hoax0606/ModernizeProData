# 2026-07-28 — ddl-dialect-routing (ks-infosys)

전제: 2026-07-27 `oracle-nonpg-jdbc-batch` 이어받음.

## 한 일
- **DDL 파싱을 선언된 엔진 dialect 로 분기** (`DdlImportService.importDdl`): `postgresql → PgSchemaExtractor`, 그 외(oracle 등) → `OracleDdlParser`. AS-IS/TO-BE 대칭. **기본값 빈값: TO-BE→postgresql(로더 규칙·기존 PG 불변), AS-IS→oracle.** → **oracle↔oracle / pg↔pg / oracle↔pg / pg↔oracle 4조합 지원**. (이전엔 TO-BE 가 PG 로 고정.)
- **UI 실물 4조합 검증 완료** — `C:\KSINFO\testfolder\{oracle to oracle, oracle to postgres, postgres to postgres, postgres to oracle}` 각 폴더에 DDL(asis/tobe)·CSV·매핑 정의서 세트 생성해 Trial→Run 통과 확인.
- 회귀: 유닛 + `*IT` 10개 = **232 tests 0F/0E**. `DdlImportServiceIT` 6/6(4조합 라우팅).

## 다음 사람이 할 일
- 전체 **미커밋**(`feature/mapping`) — PR 로.

## 함정 / 결정 이력
- **매핑 `tobe_type` 은 DuckDB CAST 타깃**(메타 아님) — `MappingImportService:437` 이 `CAST(src AS <tobe_type>)` 생성. Oracle 타입(`NUMBER`/`VARCHAR2`)을 넣으면 DuckDB 가 몰라 Trial 실패 → **DuckDB 타입(INTEGER/NUMERIC/VARCHAR)으로 써야 함**. 실제 Oracle 컬럼 타입은 TO-BE DDL 이 결정.
- **CSV 헤더 casing = AS-IS DDL 컬럼 casing** — `ExtractStage` 가 CSV 헤더로 DuckDB 테이블 생성(Oracle 대문자 / PG 소문자). 어긋나면 "컬럼 없음".
- **사이트 저장 시 TO-BE type 은 연결 Test 통과(`ok`) 해야 저장**(`CreateSiteModal.handleSubmit`). 미통과면 type 미저장 → TO-BE 라우팅이 기본 PG 로 빠져 Oracle DDL 거부.
- 코드 반영에 **백엔드 재기동 필요**(spring-boot:run).

## 안 한 것 (의도적으로)
- `tobe_type` Oracle→DuckDB 자동 번역: 코드 개선 여지 있으나 파일 규칙으로 회피.
- mysql/mssql/db2: 파서는 best-effort 되나 load 어댑터 없음(범위 밖).

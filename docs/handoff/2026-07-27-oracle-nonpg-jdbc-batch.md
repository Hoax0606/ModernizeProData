# 2026-07-27 — oracle-nonpg-jdbc-batch (ks-infosys)

## 한 일
- **TO-BE=비-PG(Oracle) 타깃 지원.** 어댑터 SPI(`LoaderAdapter`/`TobeSqlDialect`/`LoaderAdapterRegistry`)로 엔진 교체 가능화. PG는 `PostgresLoaderAdapter` 위임(동작 불변, `type` 없음/빈값→PG 폴백).
- **문자셋 파이프라인**: 소스 charset→UTF-8(`ExtractStage`+SourceReader, `EucJpSourceReader` 추가) → 내부 UTF-8(transform) → 적재 시 UTF-8→타깃 NLS 변환.
- **Oracle 적재 = `OracleLoaderAdapter.load()`의 JDBC batch INSERT** (중간 파일·sqlldr·Instant Client 없음). 원자적 `commit`/`rollback`, 4096행 배치, `TargetCharsetValidator`로 값별 charset fail-fast.
- Verify/Validation 엔진 중립화(`DuckDbSqlDialect`/`OracleSqlDialect`; checksum은 UTF-8 `STANDARD_HASH`, 숫자는 `canonicalNumber`로 scale 고정). 연결/헬스 Oracle 분기(`TobeJdbcConnect`), 사이트 `tobeEncoding` 엔진별 검증(`SiteController`).
- 검증: 198 tests green, `OracleEndToEndIT`(gvenzl) + 실물 1천만 건 이행(Load 03:16).

## 다음 사람이 할 일
- 아직 **미커밋**(`feature/mapping`) — PR로.
- 날짜/타임스탬프 bind는 IT 소규모만 커버 → 실 데이터 포맷 편차 확인 여지.

## 함정 / 결정 이력
- **DDL 파싱은 선언된 엔진 dialect 로 분기**(`DdlImportService`): `postgresql → PgSchemaExtractor`, 그 외 → `OracleDdlParser`. **TO-BE 기본값 빈값→PG**(로더 규칙, 기존 PG 프로젝트 불변). → Oracle→Oracle / PG→PG 등 4조합 지원. (이전엔 TO-BE 가 PG 로 고정이었음.)
- **문자셋 변환 주체 = ojdbc 드라이버**(INSERT 시점). `site.tobeEncoding`은 "파일 인코딩 지시"가 아니라 **fail-fast 검사 기준 charset**.
- Oracle quote-everywhere → 소문자 quoted(`"accounts"`). DBeaver 등 조회 시 인용 필수, `''`=NULL, 대용량은 클라이언트 OOM 주의(LIMIT).

## 안 한 것 (의도적)
- sqlldr direct-path(초대용량 최적화) 미도입 — JDBC batch가 대부분 볼륨 충분. 필요 시 후속.
- `OracleSqlDialect.canonicalText` NFKC 미지원(반각/전각 텍스트만 영향).

package com.ksinfo.modernize_pro_data.coordinator.load.spi;

/**
 * 엔진별 SQL 방언 — 식별자 quoting / qualified table 및 읽기 경로(Verify/Validation) SQL 조각 생성.
 *
 * <p>구현체:
 * <ul>
 *   <li>{@code PostgresSqlDialect} — TO-BE PostgreSQL</li>
 *   <li>{@code OracleSqlDialect} — TO-BE Oracle</li>
 *   <li>{@code DuckDbSqlDialect} — AS-IS 내부 엔진(DuckDB). TO-BE 는 아니지만 Validation 이 ASIS↔TOBE
 *       aggregate/checksum 을 <b>동일 의미</b>로 비교하려면 양쪽 모두 방언 조각이 필요하므로 같은 계약을 구현.</li>
 * </ul>
 *
 * <p><b>읽기 경로 계약(R1)</b>: {@code ValidationReportService} 가 ASIS(DuckDB)와 TOBE(PG/Oracle)의
 * SUM/MIN/MAX/NULL-count/checksum 을 비교. checksum 이 FAIL 대신 PASS/WARN 로 떨어지려면 canonical
 * 문자열(날짜·boolean·텍스트 정규화)이 양쪽에서 <b>같은 바이트</b>여야 한다. 각 메서드는 그 canonical
 * 표현을 엔진 문법으로 생성한다.
 */
public interface TobeSqlDialect {

    /** 식별자 quoting (PG/Oracle/DuckDB 모두 {@code "x"}; 내부 {@code "} 는 doubling). */
    String quoteIdent(String name);

    /** schema.table qualified 식별자. schema 가 비면 unquoted table 만. */
    String qualifiedTable(String schema, String table);

    /* ---------- 읽기 경로 (Validation aggregate/checksum) ---------- */

    /** 임의 식(예: {@code MIN("col")}, {@code "col"})을 텍스트로 캐스팅. PG/Duck: {@code expr::text}. */
    String textExpr(String expr);

    /** nullable 컬럼의 NULL 개수 집계식. PG/Duck: {@code COUNT(*) FILTER (WHERE "col" IS NULL)}. */
    String nullCountExpr(String physicalCol);

    /**
     * date/timestamp/timestamptz 컬럼을 양쪽 공통 문자열로 정규화 (min/max 비교 + checksum concat 공용).
     * DATE→'YYYY-MM-DD', TIMESTAMP→'YYYY-MM-DD HH:MM:SS.uuuuuu', TIMESTAMPTZ→UTC 변환 후 동일 포맷.
     *
     * @param upperType {@code DdlColumn.dataType} 의 대문자 (DATE / TIMESTAMP / TIMESTAMPTZ / TIME ZONE 판별)
     */
    String canonicalDate(String physicalCol, String upperType);

    /** boolean 컬럼 canonical — TRUE/FALSE/t/f 변종을 소문자 문자열로 통일. */
    String canonicalBoolean(String physicalCol);

    /** text 컬럼 canonical — 유니코드 NFKC 정규화 (① vs 1, ㈱ vs (株), NFD vs NFC 흡수). */
    String canonicalText(String physicalCol);

    /**
     * 숫자 컬럼 canonical — DECIMAL(p,s) 텍스트 표현을 엔진 간 <b>바이트 일치</b>시킨다. PG/DuckDB 는
     * {@code col::text} 가 이미 scale 을 고정 출력("1000.50")하지만, Oracle 은 NUMBER→VARCHAR2 시
     * trailing zero 가 사라져("1000.5") checksum 이 어긋난다 → Oracle 은 {@code TO_CHAR} 로 scale 만큼
     * 강제해 맞춘다. scale null/0 이면 정수 취급.
     */
    String canonicalNumber(String physicalCol, Integer scale);

    /**
     * count + min/max SHA-256 fingerprint 쿼리 (순서 무관, 메모리 cheap). 행별 SHA-256(concat)의
     * count|min|max 를 다시 SHA-256 → hex. PG/Duck/Oracle 이 같은 UTF-8 바이트를 해시하면 결과 일치.
     *
     * <p>행 concat 조립은 방언별 (PG/Duck: variadic {@code concat(a,'|',b)}, Oracle: {@code a||'|'||b}).
     * 그래서 조인 완료 문자열이 아니라 <b>컬럼식 리스트</b>를 받아 구현체가 자기 문법으로 잇는다.
     *
     * @param colExprs 컬럼별 식 리스트 (각각 {@code COALESCE(..., '')}) — 사이에 리터럴 {@code '|'} 구분자로 이어짐
     */
    String checksumQuery(String fqTable, java.util.List<String> colExprs);
}

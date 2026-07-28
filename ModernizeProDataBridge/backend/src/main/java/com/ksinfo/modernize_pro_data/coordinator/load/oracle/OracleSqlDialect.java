package com.ksinfo.modernize_pro_data.coordinator.load.oracle;

import com.ksinfo.modernize_pro_data.coordinator.load.spi.TobeSqlDialect;

import java.util.List;

/**
 * Oracle SQL 방언 — {@link TobeSqlDialect} 의 Oracle 구현. PG/DuckDB 와 <b>같은 의미</b>의 canonical
 * 문자열·checksum 을 Oracle 문법으로 생성해 ASIS(DuckDB, UTF-8)↔TOBE(Oracle) 비교가 성립하게 한다.
 *
 * <p>PG 대비 주요 차이(계획서 R1/R4/R5):
 * <ul>
 *   <li><b>quote-everywhere</b>(R4): 식별자를 항상 {@code "X"} 로 — Oracle 의 unquoted→UPPER 폴딩 회피,
 *       DDL/read/CTL 정책 일치.</li>
 *   <li>{@code ::text} 없음 → {@code CAST(x AS VARCHAR2(4000))}.</li>
 *   <li>{@code FILTER} 없음 → {@code COUNT(CASE WHEN ... THEN 1 END)}.</li>
 *   <li>가변 {@code concat()} 없음 → {@code ||} 연결.</li>
 *   <li>{@code sha256()} 없음 → {@code STANDARD_HASH(x, 'SHA256')} (RAW→hex, LOWER 로 소문자화).</li>
 *   <li><b>charset 패리티(핵심)</b>: Oracle DB 가 JA16SJIS 로 저장해도 checksum 은 DuckDB(UTF-8)와
 *       같아야 하므로 {@code UTL_I18N.STRING_TO_RAW(x, 'AL32UTF8')} 로 <b>UTF-8 바이트</b>를 해시.</li>
 * </ul>
 *
 * <p><b>알려진 한계(1차)</b>: {@link #canonicalText} 는 Oracle 내장 NFKC 부재로 정규화 없이 텍스트 캐스트만.
 * 반각/전각 등 NFKC 차이가 있는 텍스트는 checksum 이 WARN 대신 FAIL 로 떨어질 수 있음(→ Transform 에서
 * 정규화하거나 후속 Oracle NFKC UDF 도입으로 개선). checksum-parity IT 로 실측·추적.
 */
public final class OracleSqlDialect implements TobeSqlDialect {

    public static final OracleSqlDialect INSTANCE = new OracleSqlDialect();

    /** 항상 UTF-8 로 해시해 DuckDB(UTF-8) 와 바이트 일치시키기 위한 Oracle charset 토큰. */
    private static final String HASH_CS = "AL32UTF8";

    /** TO_CHAR 정수부 마스크 — 37×'9' + '0' (NUMBER 최대 정밀도 커버, FM 로 leading blank 제거,
     *  마지막 '0' 은 |x|<1 일 때 정수 자리 0 강제). 소수부는 scale 만큼 '0' 을 뒤에 붙인다. */
    static final String INT_MASK = "9999999999999999999999999999999999990";  // 37×9 + 0

    @Override
    public String quoteIdent(String name) {
        return "\"" + name.replace("\"", "\"\"") + "\"";
    }

    @Override
    public String qualifiedTable(String schema, String table) {
        if (schema == null || schema.isBlank()) return quoteIdent(table);
        return quoteIdent(schema) + "." + quoteIdent(table);
    }

    @Override
    public String textExpr(String expr) {
        return "CAST(" + expr + " AS VARCHAR2(4000))";
    }

    @Override
    public String nullCountExpr(String physicalCol) {
        return "COUNT(CASE WHEN " + quoteIdent(physicalCol) + " IS NULL THEN 1 END)";
    }

    @Override
    public String canonicalDate(String physicalCol, String upperType) {
        String col = quoteIdent(physicalCol);
        if (upperType.equals("DATE")) return "TO_CHAR(" + col + ", 'YYYY-MM-DD')";
        if (upperType.contains("TIMESTAMPTZ") || upperType.contains("TIME ZONE")) {
            return "TO_CHAR(CAST(" + col + " AS TIMESTAMP WITH TIME ZONE) AT TIME ZONE 'UTC', "
                    + "'YYYY-MM-DD HH24:MI:SS.FF6')";
        }
        return "TO_CHAR(CAST(" + col + " AS TIMESTAMP), 'YYYY-MM-DD HH24:MI:SS.FF6')";
    }

    @Override
    public String canonicalBoolean(String physicalCol) {
        return "LOWER(NULLIF(" + textExpr(quoteIdent(physicalCol)) + ", ''))";
    }

    @Override
    public String canonicalText(String physicalCol) {
        // 1차: NFKC 미지원 — 텍스트 캐스트만 (한계는 클래스 javadoc 참조).
        return textExpr(quoteIdent(physicalCol));
    }

    @Override
    public String canonicalNumber(String physicalCol, Integer scale) {
        // Oracle 은 NUMBER→VARCHAR2 시 trailing zero 유실 → TO_CHAR 로 scale 고정 (DuckDB/PG 의
        // DECIMAL::text 와 바이트 일치). NLS_NUMERIC_CHARACTERS 로 소수점 '.' 강제(locale ',' 방지).
        int s = scale == null || scale < 0 ? 0 : scale;
        String mask = "FM" + INT_MASK + (s > 0 ? "." + "0".repeat(s) : "");
        return "TO_CHAR(" + quoteIdent(physicalCol) + ", '" + mask + "', 'NLS_NUMERIC_CHARACTERS=''.,''')";
    }

    @Override
    public String checksumQuery(String fqTable, List<String> colExprs) {
        String rowConcat = String.join(" || '|' || ", colExprs);
        String rowHash = "LOWER(STANDARD_HASH(UTL_I18N.STRING_TO_RAW(" + rowConcat
                + ", '" + HASH_CS + "'), 'SHA256'))";
        String fp = "TO_CHAR(COUNT(*)) || '|' || COALESCE(MIN(vv), '') || '|' || COALESCE(MAX(vv), '')";
        return "SELECT LOWER(STANDARD_HASH(UTL_I18N.STRING_TO_RAW(" + fp + ", '" + HASH_CS + "'), 'SHA256'))"
                + " FROM (SELECT " + rowHash + " AS vv FROM " + fqTable + ") hh";
    }
}

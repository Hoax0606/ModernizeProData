package com.ksinfo.modernize_pro_data.coordinator.load;

import com.ksinfo.modernize_pro_data.coordinator.load.spi.TobeSqlDialect;

/**
 * DuckDB(AS-IS 내부 엔진) SQL 방언 — ValidationReportService 의 ASIS 측 읽기 경로 SQL(STRFTIME canonical,
 * nfkc_normalize UDF, sha256(varchar)) 을 이관. TO-BE 방언들과 <b>대칭</b>이라 checksum/aggregate 비교가
 * 양쪽 동일 의미로 성립한다. 내부 고정 엔진이므로 Spring 빈이 아니라 {@link #INSTANCE} 싱글턴.
 *
 * <p><b>동작 불변</b>: 문자열은 이전 static 헬퍼의 DuckDB 분기와 바이트 동일 ({@code DuckDbSqlDialectTest} 고정).
 */
public final class DuckDbSqlDialect implements TobeSqlDialect {

    public static final DuckDbSqlDialect INSTANCE = new DuckDbSqlDialect();

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
        return expr + "::text";
    }

    @Override
    public String nullCountExpr(String physicalCol) {
        return "COUNT(*) FILTER (WHERE " + quoteIdent(physicalCol) + " IS NULL)";
    }

    @Override
    public String canonicalDate(String physicalCol, String upperType) {
        String col = quoteIdent(physicalCol);
        if (upperType.equals("DATE")) return "STRFTIME(" + col + ", '%Y-%m-%d')";
        if (upperType.contains("TIMESTAMPTZ") || upperType.contains("TIME ZONE")) {
            return "STRFTIME(CAST(" + col + " AS TIMESTAMP WITH TIME ZONE) AT TIME ZONE 'UTC', '%Y-%m-%d %H:%M:%S.%f')";
        }
        return "STRFTIME(TRY_CAST(" + col + " AS TIMESTAMP), '%Y-%m-%d %H:%M:%S.%f')";
    }

    @Override
    public String canonicalBoolean(String physicalCol) {
        return "LOWER(NULLIF(" + quoteIdent(physicalCol) + "::text, ''))";
    }

    @Override
    public String canonicalText(String physicalCol) {
        return "nfkc_normalize(" + quoteIdent(physicalCol) + "::text)";
    }

    @Override
    public String canonicalNumber(String physicalCol, Integer scale) {
        // DuckDB DECIMAL(p,s)::text 는 scale 고정 출력("1000.50") — 그대로 사용.
        return quoteIdent(physicalCol) + "::text";
    }

    @Override
    public String checksumQuery(String fqTable, java.util.List<String> colExprs) {
        // DuckDB : sha256(varchar)→hex varchar.
        String rowConcat = String.join(", '|', ", colExprs);
        return "SELECT sha256("
                + "count(*)::text || '|' || coalesce(min(_v), '') || '|' || coalesce(max(_v), '')"
                + ") FROM (SELECT sha256(concat(" + rowConcat + ")) AS _v FROM " + fqTable + ") _h";
    }
}

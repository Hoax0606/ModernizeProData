package com.ksinfo.modernize_pro_data.coordinator.load;

import com.ksinfo.modernize_pro_data.coordinator.load.spi.TobeSqlDialect;

/**
 * PostgreSQL SQL 방언 — 기존 PgDdlGenerator/LoadStage quoting({@code "x"}) + ValidationReportService
 * 의 PG 읽기 경로 SQL(FILTER null-count, TO_CHAR canonical, normalize NFKC, encode(sha256(convert_to)))
 * 을 그대로 이관. <b>동작 불변</b>: 문자열은 이전 static 헬퍼와 바이트 동일 ({@code PostgresSqlDialectTest} 고정).
 */
public final class PostgresSqlDialect implements TobeSqlDialect {

    public static final PostgresSqlDialect INSTANCE = new PostgresSqlDialect();

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
        if (upperType.equals("DATE")) return "TO_CHAR(" + col + ", 'YYYY-MM-DD')";
        if (upperType.contains("TIMESTAMPTZ") || upperType.contains("TIME ZONE")) {
            return "TO_CHAR((" + col + ") AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US')";
        }
        return "TO_CHAR(CAST(" + col + " AS TIMESTAMP), 'YYYY-MM-DD HH24:MI:SS.US')";
    }

    @Override
    public String canonicalBoolean(String physicalCol) {
        return "LOWER(NULLIF(" + quoteIdent(physicalCol) + "::text, ''))";
    }

    @Override
    public String canonicalText(String physicalCol) {
        return "normalize(" + quoteIdent(physicalCol) + "::text, NFKC)";
    }

    @Override
    public String canonicalNumber(String physicalCol, Integer scale) {
        // PG NUMERIC(p,s)::text 는 scale 고정 출력("1000.50") — 그대로 사용 (DuckDB 와 동일).
        return quoteIdent(physicalCol) + "::text";
    }

    @Override
    public String checksumQuery(String fqTable, java.util.List<String> colExprs) {
        // PostgreSQL 11+ : sha256(bytea)→bytea. text 를 UTF8 bytea(convert_to)로 변환 후 해시 → hex.
        String rowConcat = String.join(", '|', ", colExprs);
        String row = "encode(sha256(convert_to(concat(" + rowConcat + "), 'UTF8')), 'hex')";
        return "SELECT encode(sha256(convert_to("
                + "count(*)::text || '|' || coalesce(min(_v), '') || '|' || coalesce(max(_v), '')"
                + ", 'UTF8')), 'hex') FROM (SELECT " + row + " AS _v FROM " + fqTable + ") _h";
    }
}

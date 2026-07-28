package com.ksinfo.modernize_pro_data.coordinator.load;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;

/**
 * DuckDbSqlDialect — R1 추출 회귀 고정. ValidationReportService 의 이전 DuckDB 분기와 바이트 동일.
 */
class DuckDbSqlDialectTest {

    private final DuckDbSqlDialect d = DuckDbSqlDialect.INSTANCE;

    @Test
    void textAndNullCount() {
        assertEquals("MIN(\"c\")::text", d.textExpr("MIN(\"c\")"));
        assertEquals("COUNT(*) FILTER (WHERE \"c\" IS NULL)", d.nullCountExpr("c"));
    }

    @Test
    void canonicalDate() {
        assertEquals("STRFTIME(\"c\", '%Y-%m-%d')", d.canonicalDate("c", "DATE"));
        assertEquals("STRFTIME(TRY_CAST(\"c\" AS TIMESTAMP), '%Y-%m-%d %H:%M:%S.%f')",
                d.canonicalDate("c", "TIMESTAMP"));
        assertEquals("STRFTIME(CAST(\"c\" AS TIMESTAMP WITH TIME ZONE) AT TIME ZONE 'UTC', '%Y-%m-%d %H:%M:%S.%f')",
                d.canonicalDate("c", "TIMESTAMPTZ"));
    }

    @Test
    void canonicalBooleanAndText() {
        assertEquals("LOWER(NULLIF(\"c\"::text, ''))", d.canonicalBoolean("c"));
        assertEquals("nfkc_normalize(\"c\"::text)", d.canonicalText("c"));
    }

    @Test
    void canonicalNumber_viaText() {
        // DuckDB DECIMAL::text 는 이미 scale 고정 → ::text 그대로.
        assertEquals("\"balance\"::text", d.canonicalNumber("balance", 2));
        assertEquals("\"n\"::text", d.canonicalNumber("n", null));
    }

    @Test
    void checksumQuery() {
        String q = d.checksumQuery("\"s\".\"tobe_t\"", java.util.List.of("COALESCE(\"id\"::text, '')"));
        assertEquals("SELECT sha256("
                + "count(*)::text || '|' || coalesce(min(_v), '') || '|' || coalesce(max(_v), '')"
                + ") FROM (SELECT sha256(concat(COALESCE(\"id\"::text, ''))) AS _v FROM \"s\".\"tobe_t\") _h", q);
    }
}

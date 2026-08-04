package com.ksinfo.modernize_pro_data.coordinator.load;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;

/**
 * PostgresSqlDialect — R1 추출 회귀 고정. 여기 문자열은 ValidationReportService 의 이전 PG 분기와
 * <b>바이트 동일</b>해야 한다 (EndToEndGreenIT/Validation IT 가 실제 PG 로 재검증).
 */
class PostgresSqlDialectTest {

    private final PostgresSqlDialect d = PostgresSqlDialect.INSTANCE;

    @Test
    void quotingAndQualified() {
        assertEquals("\"a\"\"b\"", d.quoteIdent("a\"b"));
        assertEquals("\"s\".\"t\"", d.qualifiedTable("s", "t"));
        assertEquals("\"t\"", d.qualifiedTable("", "t"));
        assertEquals("\"t\"", d.qualifiedTable(null, "t"));
    }

    @Test
    void textAndNullCount() {
        assertEquals("MIN(\"c\")::text", d.textExpr("MIN(\"c\")"));
        assertEquals("COUNT(*) FILTER (WHERE \"c\" IS NULL)", d.nullCountExpr("c"));
    }

    @Test
    void canonicalDate() {
        assertEquals("TO_CHAR(\"c\", 'YYYY-MM-DD')", d.canonicalDate("c", "DATE"));
        assertEquals("TO_CHAR(CAST(\"c\" AS TIMESTAMP), 'YYYY-MM-DD HH24:MI:SS.US')",
                d.canonicalDate("c", "TIMESTAMP"));
        assertEquals("TO_CHAR((\"c\") AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US')",
                d.canonicalDate("c", "TIMESTAMPTZ"));
        assertEquals("TO_CHAR((\"c\") AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US')",
                d.canonicalDate("c", "TIMESTAMP WITH TIME ZONE"));
    }

    @Test
    void canonicalBooleanAndText() {
        assertEquals("LOWER(NULLIF(\"c\"::text, ''))", d.canonicalBoolean("c"));
        assertEquals("normalize(\"c\"::text, NFKC)", d.canonicalText("c"));
    }

    @Test
    void canonicalNumber_viaText() {
        // PG NUMERIC::text 는 이미 scale 고정 → ::text 그대로 (scale 무시).
        assertEquals("\"balance\"::text", d.canonicalNumber("balance", 2));
        assertEquals("\"n\"::text", d.canonicalNumber("n", null));
    }

    @Test
    void checksumQuery() {
        String q = d.checksumQuery("\"public\".\"t\"", java.util.List.of("COALESCE(\"id\"::text, '')"));
        assertEquals("SELECT encode(sha256(convert_to("
                + "count(*)::text || '|' || coalesce(min(_v), '') || '|' || coalesce(max(_v), '')"
                + ", 'UTF8')), 'hex') FROM (SELECT "
                + "encode(sha256(convert_to(concat(COALESCE(\"id\"::text, '')), 'UTF8')), 'hex')"
                + " AS _v FROM \"public\".\"t\") _h", q);
    }
}

package com.ksinfo.modernize_pro_data.coordinator.load.oracle;

import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;

/** OracleSqlDialect — Oracle 읽기경로 SQL 문자열 고정 (Docker 불필요; 의미 패리티는 checksum-parity IT). */
class OracleSqlDialectTest {

    private final OracleSqlDialect d = OracleSqlDialect.INSTANCE;

    @Test
    void quotingAndQualified() {
        assertEquals("\"a\"\"b\"", d.quoteIdent("a\"b"));
        assertEquals("\"S\".\"T\"", d.qualifiedTable("S", "T"));
        assertEquals("\"T\"", d.qualifiedTable("", "T"));
        assertEquals("\"T\"", d.qualifiedTable(null, "T"));
    }

    @Test
    void textAndNullCount_noColonCastNoFilter() {
        assertEquals("CAST(MIN(\"C\") AS VARCHAR2(4000))", d.textExpr("MIN(\"C\")"));
        assertEquals("COUNT(CASE WHEN \"C\" IS NULL THEN 1 END)", d.nullCountExpr("C"));
    }

    @Test
    void canonicalDate_oracleFormatModels() {
        assertEquals("TO_CHAR(\"C\", 'YYYY-MM-DD')", d.canonicalDate("C", "DATE"));
        assertEquals("TO_CHAR(CAST(\"C\" AS TIMESTAMP), 'YYYY-MM-DD HH24:MI:SS.FF6')",
                d.canonicalDate("C", "TIMESTAMP"));
        assertEquals("TO_CHAR(CAST(\"C\" AS TIMESTAMP WITH TIME ZONE) AT TIME ZONE 'UTC', "
                        + "'YYYY-MM-DD HH24:MI:SS.FF6')",
                d.canonicalDate("C", "TIMESTAMPTZ"));
    }

    @Test
    void canonicalBooleanAndText() {
        assertEquals("LOWER(NULLIF(CAST(\"C\" AS VARCHAR2(4000)), ''))", d.canonicalBoolean("C"));
        assertEquals("CAST(\"C\" AS VARCHAR2(4000))", d.canonicalText("C"));
    }

    @Test
    void canonicalNumber_toCharScaleFixed() {
        // Oracle 은 NUMBER→VARCHAR2 시 trailing zero 유실 → TO_CHAR 로 scale 고정 (DuckDB/PG 와 일치).
        assertEquals("TO_CHAR(\"BALANCE\", 'FM" + OracleSqlDialect.INT_MASK + ".00', 'NLS_NUMERIC_CHARACTERS=''.,''')",
                d.canonicalNumber("BALANCE", 2));
        assertEquals("TO_CHAR(\"ID\", 'FM" + OracleSqlDialect.INT_MASK + "', 'NLS_NUMERIC_CHARACTERS=''.,''')",
                d.canonicalNumber("ID", null));
    }

    @Test
    void checksumQuery_standardHashOverUtf8Bytes() {
        String q = d.checksumQuery("\"S\".\"T\"", List.of("COALESCE(CAST(\"ID\" AS VARCHAR2(4000)), '')"));
        assertEquals("SELECT LOWER(STANDARD_HASH(UTL_I18N.STRING_TO_RAW("
                + "TO_CHAR(COUNT(*)) || '|' || COALESCE(MIN(vv), '') || '|' || COALESCE(MAX(vv), '')"
                + ", 'AL32UTF8'), 'SHA256')) FROM (SELECT "
                + "LOWER(STANDARD_HASH(UTL_I18N.STRING_TO_RAW("
                + "COALESCE(CAST(\"ID\" AS VARCHAR2(4000)), ''), 'AL32UTF8'), 'SHA256'))"
                + " AS vv FROM \"S\".\"T\") hh", q);
    }
}

package com.ksinfo.modernize_pro_data.coordinator.mapping;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * MappingImportService 의 notes 지시자 파서 순수 단위 테스트 (DB/Docker 불필요).
 * 샘플 CSV 가 transform/expand 로직을 notes 에 '<U+2001>E<key>: <value>' 로 넣어둔 포맷 파싱.
 */
class MappingNotesParseTest {

    private static final String SEP = " ";  // 실제 CSV 마커 (EM QUAD)

    @Test
    void transformSql_extracted() {
        assertEquals("t.CUST_ID",
                MappingImportService.notesDirective("1:N " + SEP + "Etransform_sql: t.CUST_ID", "transform_sql:"));
    }

    @Test
    void transformSql_aggregate_withCommasAndQuotes_preserved() {
        String notes = "aggregate " + SEP + "Etransform_sql: SUM(CASE WHEN t.TXN_TYPE = 'C' THEN CAST(t.AMOUNT AS DECIMAL(20,2)) ELSE 0 END)";
        assertEquals("SUM(CASE WHEN t.TXN_TYPE = 'C' THEN CAST(t.AMOUNT AS DECIMAL(20,2)) ELSE 0 END)",
                MappingImportService.notesDirective(notes, "transform_sql:"));
    }

    @Test
    void transformSql_groupByAnnotation_stripped() {
        String notes = "group key " + SEP + "Etransform_sql: SUBSTRING(t.TXN_DTTM, 1, 7)  (GROUP BY expr)";
        assertEquals("SUBSTRING(t.TXN_DTTM, 1, 7)",
                MappingImportService.notesDirective(notes, "transform_sql:"));
    }

    @Test
    void expandExpr_extracted_upToWhere() {
        String notes = "u.channel " + SEP + "Eexpand_expr: CROSS JOIN LATERAL (VALUES ('phone', t.PHONE), ('email', t.EMAIL)) AS u(channel, value), where: u.value IS NOT NULL AND TRIM(u.value) <> ''";
        assertEquals("CROSS JOIN LATERAL (VALUES ('phone', t.PHONE), ('email', t.EMAIL)) AS u(channel, value)",
                MappingImportService.notesDirective(notes, "expand_expr:"));
        assertEquals("u.value IS NOT NULL AND TRIM(u.value) <> ''",
                MappingImportService.notesWhere(notes));
    }

    @Test
    void noKey_returnsNull() {
        assertNull(MappingImportService.notesDirective("just a plain note", "transform_sql:"));
        assertNull(MappingImportService.notesDirective(null, "transform_sql:"));
        assertNull(MappingImportService.notesWhere("no where here"));
    }

    @Test
    void isAggregate_detectsAggFunctions() {
        assertTrue(MappingImportService.isAggregate("COUNT(*)"));
        assertTrue(MappingImportService.isAggregate("SUM(CASE WHEN x THEN 1 ELSE 0 END)"));
        assertTrue(MappingImportService.isAggregate("  min(t.x)"));   // 대소문자·선행공백 무시
        assertFalse(MappingImportService.isAggregate("t.ACCT_NO"));
        assertFalse(MappingImportService.isAggregate("SUBSTRING(t.TXN_DTTM, 1, 7)"));  // 집계 아님
        assertFalse(MappingImportService.isAggregate(null));
    }
}

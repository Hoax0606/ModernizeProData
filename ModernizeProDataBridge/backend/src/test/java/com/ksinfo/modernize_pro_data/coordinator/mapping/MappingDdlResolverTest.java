package com.ksinfo.modernize_pro_data.coordinator.mapping;

import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

/**
 * MappingImportService.DdlResolver — CSV 의 tobe_schema/table/column 이 DDL 과 대소문자·스키마
 * 유무가 달라도 DDL 의 정식 이름으로 교정하는지 검증. 이게 없으면 per-table import 의
 * case-sensitive 매칭에서 全 row 가 걸러져 "매핑정의서에 명세 안 됨" 경고와 함께 아무것도
 * 임포트되지 않던 버그(2026-07-07 화면 재현).
 */
class MappingDdlResolverTest {

    private MappingImportService.DdlResolver sample() {
        MappingImportService.DdlResolver r = new MappingImportService.DdlResolver();
        r.addTable("bigassignseq", "transaction_reissued",
                List.of("new_txn_seq", "legacy_txn_id", "acct_no_masked", "txn_type", "amount"));
        r.addTable("bigassignseq", "customer", List.of("customer_id", "customer_name"));
        return r;
    }

    @Test
    void exactSchemaAndTableMatch() {
        assertArrayEquals(new String[] { "bigassignseq", "transaction_reissued" },
                sample().resolveTable("bigassignseq", "transaction_reissued"));
    }

    @Test
    void caseInsensitiveTableMatchReturnsCanonical() {
        // CSV 가 대문자로 썼어도 DDL 의 소문자 정식 이름으로 교정돼야 한다.
        assertArrayEquals(new String[] { "bigassignseq", "transaction_reissued" },
                sample().resolveTable("BIGASSIGNSEQ", "TRANSACTION_REISSUED"));
    }

    @Test
    void schemaOmittedInCsvStillMatchesSchemaQualifiedDdl() {
        // CSV 가 스키마를 생략(bare)해도 DDL 의 schema-qualified 테이블에 매칭 + 정식 schema 부여.
        assertArrayEquals(new String[] { "bigassignseq", "transaction_reissued" },
                sample().resolveTable("", "Transaction_Reissued"));
    }

    @Test
    void unknownTableReturnsNull() {
        assertNull(sample().resolveTable("bigassignseq", "no_such_table"));
    }

    @Test
    void columnResolvedCaseInsensitivelyToCanonical() {
        assertEquals("acct_no_masked",
                sample().resolveColumn("", "transaction_reissued", "ACCT_NO_MASKED"));
    }

    @Test
    void unknownColumnKeptAsIs() {
        // DDL 에 없는 컬럼은 입력값 그대로 (스키마/타입 등 다른 검증 단계에 맡김).
        assertEquals("weird_col",
                sample().resolveColumn("", "transaction_reissued", "weird_col"));
    }

    @Test
    void ambiguousBareTableNotResolvedBySchemalessQuery() {
        // 서로 다른 스키마에 같은 bare 이름이 둘 → schema 없는 조회는 모호하므로 매칭 거부.
        MappingImportService.DdlResolver r = new MappingImportService.DdlResolver();
        r.addTable("s1", "orders", List.of("id"));
        r.addTable("s2", "orders", List.of("id"));
        assertNull(r.resolveTable("", "orders"));
        // 단, schema 를 명시하면 정확히 매칭.
        assertArrayEquals(new String[] { "s2", "orders" }, r.resolveTable("s2", "ORDERS"));
    }

    @Test
    void columnGate_hasColumnDataAndCanonicalColumn() {
        MappingImportService.DdlResolver r = sample();
        // 컬럼 정보 있음
        org.junit.jupiter.api.Assertions.assertTrue(r.hasColumnData("bigassignseq", "transaction_reissued"));
        org.junit.jupiter.api.Assertions.assertTrue(r.hasColumnData("", "customer"));
        // 존재 컬럼 → 정식명(대소문자 무시), 미존재 → null (게이트가 skip)
        assertEquals("amount", r.canonicalColumn("", "transaction_reissued", "AMOUNT"));
        assertNull(r.canonicalColumn("", "transaction_reissued", "not_a_column"));
        // customer 테이블엔 amount 없음 → null (같은 컬럼명이 다른 테이블 subset 인 상황)
        assertNull(r.canonicalColumn("", "customer", "amount"));
        assertEquals("customer_id", r.canonicalColumn("", "customer", "CUSTOMER_ID"));
    }

    @Test
    void columnGate_noColumnDataWhenTableUnknown() {
        MappingImportService.DdlResolver r = sample();
        org.junit.jupiter.api.Assertions.assertFalse(r.hasColumnData("", "no_such_table"));
    }

    @Test
    void emptyResolverIsEmpty() {
        assertEquals(true, new MappingImportService.DdlResolver().isEmpty());
        assertEquals(false, sample().isEmpty());
    }
}

package com.ksinfo.modernize_pro_data.coordinator.worker;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

/**
 * StageHelpers.resolveCsvFile — AS-IS 추출 파일명과 DDL/binding 테이블명 규칙이 어긋나도
 * 같은 파일을 찾는지 검증. 핵심: DDL 이 스키마 없이(CONTACT_INFO) import 됐는데 추출 파일은
 * 스키마 포함(BANKSYS.CONTACT_INFO.csv)인 경우, bare 이름으로도 그 파일을 찾아야 Trial 게이트가
 * 막히지 않는다(2026-07-08). 단 여러 스키마에 같은 테이블명이 있으면 모호하므로 매칭 안 함.
 */
class StageHelpersResolveCsvTest {

    private void touch(Path dir, String name) throws IOException {
        Files.writeString(dir.resolve(name), "col1,col2\n1,2\n");
    }

    private static void assertEqualsIgnoreCase(String expected, String actual) {
        org.junit.jupiter.api.Assertions.assertTrue(expected.equalsIgnoreCase(actual),
                "expected (ignore case): " + expected + " but was: " + actual);
    }

    @Test
    void bareNameResolvesToSchemaPrefixedFile(@TempDir Path dir) throws IOException {
        touch(dir, "BANKSYS.CONTACT_INFO.csv");
        // bare DDL 테이블명 → 스키마 접두 파일 매칭
        assertEquals("BANKSYS.CONTACT_INFO.csv",
                StageHelpers.resolveCsvFile(dir, "CONTACT_INFO").getFileName().toString());
        // 대소문자 무시
        assertEquals("BANKSYS.CONTACT_INFO.csv",
                StageHelpers.resolveCsvFile(dir, "contact_info").getFileName().toString());
    }

    @Test
    void schemaQualifiedNameResolvesViaThreeArg(@TempDir Path dir) throws IOException {
        touch(dir, "BANKSYS.CONTACT_INFO.csv");
        touch(dir, "customers.csv");
        // run 경로는 binding 의 (schema, table) 3-arg 버전을 쓴다.
        // (Windows FS 대소문자 무시 → exact 매칭은 질의 casing 을 돌려줄 수 있어 equalsIgnoreCase 비교.)
        assertEqualsIgnoreCase("BANKSYS.CONTACT_INFO.csv",
                StageHelpers.resolveCsvFile(dir, "BANKSYS", "CONTACT_INFO").getFileName().toString());
        // schema.table 의 exact 파일이 없으면 점 뒤(table) fallback → customers.csv
        assertEqualsIgnoreCase("customers.csv",
                StageHelpers.resolveCsvFile(dir, "BANKSYS", "CUSTOMERS").getFileName().toString());
    }

    @Test
    void bareNameExactWinsOverPrefixed(@TempDir Path dir) throws IOException {
        touch(dir, "customers.csv");
        touch(dir, "OLD.CUSTOMERS.csv");
        // bare 이름의 exact/ci 파일이 있으면 그게 우선 (접두 파일 OLD.CUSTOMERS.csv 아님).
        // (Windows FS 는 대소문자 무시라 반환 파일명 casing 은 질의값일 수 있어 equalsIgnoreCase 로 비교.)
        String resolved = StageHelpers.resolveCsvFile(dir, "CUSTOMERS").getFileName().toString();
        org.junit.jupiter.api.Assertions.assertTrue(resolved.equalsIgnoreCase("customers.csv"),
                "bare exact/ci 파일이 우선해야 한다 (got: " + resolved + ")");
    }

    @Test
    void ambiguousSchemaPrefixNotResolved(@TempDir Path dir) throws IOException {
        touch(dir, "MAINFRAME.EMPLOYEES.csv");
        touch(dir, "HR_PAYROLL.EMPLOYEES.csv");
        // 여러 스키마에 같은 table 명 → bare 이름으로는 모호하므로 매칭 안 함
        assertNull(StageHelpers.resolveCsvFile(dir, "EMPLOYEES"));
        // 단 스키마를 명시하면 정확히 매칭
        assertEquals("HR_PAYROLL.EMPLOYEES.csv",
                StageHelpers.resolveCsvFile(dir, "HR_PAYROLL.EMPLOYEES").getFileName().toString());
    }

    @Test
    void underscoreIsNotSchemaSeparator(@TempDir Path dir) throws IOException {
        touch(dir, "shop_orders.csv");
        // 'shop_orders.csv' 는 bare 'orders' 의 스키마 접두 파일이 아님 (구분자는 '.' 만)
        assertNull(StageHelpers.resolveCsvFile(dir, "orders"));
        assertEquals("shop_orders.csv",
                StageHelpers.resolveCsvFile(dir, "shop_orders").getFileName().toString());
    }

    @Test
    void missingReturnsNull(@TempDir Path dir) throws IOException {
        touch(dir, "customers.csv");
        assertNull(StageHelpers.resolveCsvFile(dir, "no_such_table"));
    }
}

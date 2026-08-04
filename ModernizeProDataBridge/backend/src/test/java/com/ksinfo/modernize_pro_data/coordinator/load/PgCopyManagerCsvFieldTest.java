package com.ksinfo.modernize_pro_data.coordinator.load;

import org.junit.jupiter.api.Test;

import java.math.BigDecimal;
import java.sql.Date;
import java.time.LocalDate;

import static org.junit.jupiter.api.Assertions.assertEquals;

/**
 * PgCopyManager.appendCsvField — Load 직렬화 계약 (핸드오프 Task C).
 *
 * COPY (FORMAT csv) 로 PG 에 넘길 텍스트를 만드는 규칙을 고정한다. 이 텍스트가 그대로
 * PG 의 타입 파서로 들어가므로, 여기서 결정되는 것:
 *   - null           → 빈 필드(따옴표 없음)   → PG NULL
 *   - "" (빈 문자열)  → "" (따옴표 있음)        → PG 빈 문자열 (NULL 아님)
 *   - 그 외          → toString(), 쉼표/따옴표/개행 있을 때만 감쌈 (RFC 4180)
 *
 * PG 쪽 파싱(빈 필드→NULL, 'Y'/'1'→bool, "yyyy-MM-dd"→date)의 실제 왕복은
 * {@link PgCopyTypeContractIT} 에서 Testcontainers 로 검증.
 */
class PgCopyManagerCsvFieldTest {

    private static String field(Object v) {
        StringBuilder sb = new StringBuilder();
        PgCopyManager.appendCsvField(sb, v);
        return sb.toString();
    }

    // ---- empty ↔ NULL 구분 (계약의 핵심) ----------------------------------

    @Test
    void null_becomesUnquotedEmpty_soPgReadsNull() {
        assertEquals("", field(null));
    }

    @Test
    void emptyString_becomesQuotedEmpty_soPgReadsEmptyStringNotNull() {
        assertEquals("\"\"", field(""));
    }

    // ---- 숫자 / 불리언 / 날짜 : toString 그대로 (locale/format 가공 없음) ----

    @Test
    void integer_plainDigits() {
        assertEquals("123", field(123));
        assertEquals("-7", field(-7));
        assertEquals("0", field(0));
    }

    @Test
    void longValue_plainDigits() {
        assertEquals("9007199254740993", field(9007199254740993L));
    }

    @Test
    void bigDecimal_plainDecimal_noThousandsSeparator() {
        assertEquals("1234567.89", field(new BigDecimal("1234567.89")));
        assertEquals("0.00", field(new BigDecimal("0.00")));
    }

    @Test
    void boolean_lowercaseTrueFalse() {
        // PG bool 은 true/false 를 그대로 받는다 (y/n/1/0 도 받지만 우리는 toString).
        assertEquals("true", field(Boolean.TRUE));
        assertEquals("false", field(Boolean.FALSE));
    }

    @Test
    void sqlDate_isoYyyyMmDd() {
        assertEquals("2024-01-15", field(Date.valueOf("2024-01-15")));
    }

    @Test
    void localDate_isoYyyyMmDd() {
        assertEquals("2024-01-15", field(LocalDate.of(2024, 1, 15)));
    }

    // ---- 인용 규칙 (RFC 4180) ---------------------------------------------

    @Test
    void plainText_notQuoted() {
        assertEquals("hello", field("hello"));
        assertEquals("고객명", field("고객명"));
    }

    @Test
    void comma_forcesQuoting() {
        assertEquals("\"a,b\"", field("a,b"));
    }

    @Test
    void doubleQuote_isDoubledAndFieldQuoted() {
        assertEquals("\"say \"\"hi\"\"\"", field("say \"hi\""));
    }

    @Test
    void newlineAndCr_forceQuoting() {
        assertEquals("\"line1\nline2\"", field("line1\nline2"));
        assertEquals("\"a\rb\"", field("a\rb"));
    }

    @Test
    void appendMultipleFields_commaSeparatedByCaller() {
        // copyInFromResultSet 의 루프가 필드 사이에 ',' 를 넣는 방식 재현.
        StringBuilder sb = new StringBuilder();
        PgCopyManager.appendCsvField(sb, 1);
        sb.append(',');
        PgCopyManager.appendCsvField(sb, null);      // NULL
        sb.append(',');
        PgCopyManager.appendCsvField(sb, "");        // 빈 문자열
        sb.append(',');
        PgCopyManager.appendCsvField(sb, "x,y");     // 쉼표 → 인용
        assertEquals("1,,\"\",\"x,y\"", sb.toString());
    }
}

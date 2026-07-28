package com.ksinfo.modernize_pro_data.coordinator.load.charset;

import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.charset.Charset;
import java.nio.charset.CharsetEncoder;

import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;

/** TargetCharsetValidator — JDBC 적재 전 타깃 charset 표현 가능성 fail-fast (Docker 불필요). */
class TargetCharsetValidatorTest {

    @Test
    void sjisEncodable_passes() {
        CharsetEncoder enc = TargetCharsetValidator.reportingEncoder(Charset.forName("windows-31j"));
        assertDoesNotThrow(() -> {
            TargetCharsetValidator.checkEncodable(enc, "あかり髙橋", 1, "owner");  // 일본어(SJIS 가능)
            TargetCharsetValidator.checkEncodable(enc, "Tanaka", 2, "owner");     // ASCII
            TargetCharsetValidator.checkEncodable(enc, null, 3, "owner");         // null 통과
            TargetCharsetValidator.checkEncodable(enc, "", 4, "owner");           // empty 통과
        });
    }

    @Test
    void nonSjisChar_failsFastWithRowColCodepoint() {
        CharsetEncoder enc = TargetCharsetValidator.reportingEncoder(Charset.forName("windows-31j"));
        IOException ex = assertThrows(IOException.class,
                () -> TargetCharsetValidator.checkEncodable(enc, "ok가", 7, "owner"));  // 한글 '가'=U+AC00 SJIS 불가
        assertTrue(ex.getMessage().contains("row 7"), ex.getMessage());
        assertTrue(ex.getMessage().contains("AC00"), "코드포인트 U+AC00 명시: " + ex.getMessage());
        assertTrue(ex.getMessage().contains("owner"), "컬럼명 명시: " + ex.getMessage());
    }

    @Test
    void utf8_alwaysPasses() {
        CharsetEncoder enc = TargetCharsetValidator.reportingEncoder(Charset.forName("UTF-8"));
        assertDoesNotThrow(() -> TargetCharsetValidator.checkEncodable(enc, "가나다あ漢", 1, "c"));
    }
}

package com.ksinfo.modernize_pro_data.coordinator.mapping;

import org.junit.jupiter.api.Test;

import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;

/**
 * MappingImportService.toUtf8 — 비 UTF-8 정의서(CP949/Shift_JIS)를 UTF-8 로 정규화하는지 검증.
 * 이게 없으면 한/일 Excel 의 ANSI 저장 CSV 에서 멀티바이트 row 가 read_csv 의 ignore_errors 로
 * silent drop 돼 일부 컬럼만 매핑되던 버그(2026-06-16).
 */
class MappingImportUtf8Test {

    @Test
    void cp949KoreanBecomesValidUtf8() {
        // 한국 Excel 이 저장하는 CP949(MS949) 바이트.
        byte[] cp949 = "고객명".getBytes(Charset.forName("MS949"));
        // 전제: 이 바이트는 그대로 UTF-8 로 읽으면 깨진다(=read_csv 가 drop 하던 상황).
        byte[] out = MappingImportService.toUtf8(cp949);
        assertEquals("고객명", new String(out, StandardCharsets.UTF_8),
                "CP949 한글이 UTF-8 로 올바르게 전사돼야 한다");
    }

    @Test
    void nonUtf8AlwaysBecomesValidUtf8_rowsPreserved() {
        // 핵심 계약: 어떤 비 UTF-8 입력이든 출력은 항상 valid UTF-8 → read_csv 가 행을 drop 하지 않는다.
        // (Shift_JIS 일어 notes 의 정확한 디코드는 best-effort — CP949/Shift_JIS 는 trial-decode 로
        //  구분 불가하므로. 행 보존이 이 함수의 목적이고, 그건 항상 보장된다.)
        byte[] sjis = "T,c,顧客名".getBytes(Charset.forName("Shift_JIS"));
        byte[] out = MappingImportService.toUtf8(sjis);
        // 출력이 valid UTF-8 인가 = 디코드→재인코드 round-trip 이 동일.
        String decoded = new String(out, StandardCharsets.UTF_8);
        assertArrayEquals(out, decoded.getBytes(StandardCharsets.UTF_8),
                "비 UTF-8 입력도 항상 valid UTF-8 로 정규화돼 행이 보존돼야 한다");
        // ASCII 구조(콤마/필드)는 보존 — CSV 가 안 깨진다.
        org.junit.jupiter.api.Assertions.assertTrue(decoded.startsWith("T,c,"),
                "ASCII 필드/구분자는 보존돼야 한다");
    }

    @Test
    void alreadyUtf8IsPreserved() {
        byte[] utf8 = "year_month,고객,顧客".getBytes(StandardCharsets.UTF_8);
        byte[] out = MappingImportService.toUtf8(utf8);
        assertEquals("year_month,고객,顧客", new String(out, StandardCharsets.UTF_8));
    }

    @Test
    void asciiUnchanged() {
        byte[] ascii = "tobe_table,tobe_column,asis_table\nT,c,A".getBytes(StandardCharsets.US_ASCII);
        byte[] out = MappingImportService.toUtf8(ascii);
        assertArrayEquals(ascii, out, "순수 ASCII 는 바이트 그대로여야 한다");
    }

    @Test
    void utf8BomStripped() {
        byte[] withBom = new byte[] { (byte) 0xEF, (byte) 0xBB, (byte) 0xBF, 't', 'o', 'b', 'e' };
        byte[] out = MappingImportService.toUtf8(withBom);
        assertEquals("tobe", new String(out, StandardCharsets.UTF_8), "BOM 은 제거돼야 한다");
    }
}

package com.ksinfo.modernize_pro_data.common.util;

import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * CsvInputGuard — UTF-8 입력 계약 강제(2026-07-08). read_csv 로 넘기기 전에 AS-IS CSV 를
 * BOM/NUL/UTF-8 well-formedness 로 검사. 비 UTF-8(Shift-JIS 등)·NUL 은 reject.
 */
class CsvInputGuardTest {

    private static byte[] bytes(int... b) {
        byte[] r = new byte[b.length];
        for (int i = 0; i < b.length; i++) r[i] = (byte) b[i];
        return r;
    }

    @Test
    void validUtf8_asciiAndMultibyte_passes() {
        byte[] data = "id,name\n1,고객명\n2,顧客名\n".getBytes(StandardCharsets.UTF_8);
        CsvInputGuard.Result r = CsvInputGuard.inspect(data);
        assertTrue(r.ok(), "valid UTF-8 (한/일 포함) 은 통과해야 한다: " + r.reason());
        assertFalse(r.bom());
    }

    @Test
    void fourByteUtf8_emoji_passes() {
        // U+1F600 (😀) = F0 9F 98 80 — 4-byte UTF-8, PG UTF8 에서 정상.
        byte[] data = "id,x\n1,😀\n".getBytes(StandardCharsets.UTF_8);
        assertTrue(CsvInputGuard.inspect(data).ok());
    }

    @Test
    void bom_detectedButValid() {
        byte[] bom = bytes(0xEF, 0xBB, 0xBF);
        byte[] body = "id,name\n1,x\n".getBytes(StandardCharsets.UTF_8);
        byte[] data = new byte[bom.length + body.length];
        System.arraycopy(bom, 0, data, 0, bom.length);
        System.arraycopy(body, 0, data, bom.length, body.length);
        CsvInputGuard.Result r = CsvInputGuard.inspect(data);
        assertTrue(r.ok(), "BOM 은 valid UTF-8(U+FEFF) 이라 통과");
        assertTrue(r.bom(), "BOM 은 감지돼야 한다(reader 가 strip)");
    }

    @Test
    void nul_rejected() {
        byte[] data = bytes('i', 'd', ',', 'x', '\n', '1', ',', 0x00, '\n');
        CsvInputGuard.Result r = CsvInputGuard.inspect(data);
        assertFalse(r.ok(), "NUL(0x00) 은 reject 돼야 한다");
        assertEquals(7, r.offset());
        assertTrue(r.reason().contains("NUL"));
    }

    @Test
    void shiftJisBytes_rejectedAsInvalidUtf8() {
        // Shift-JIS 'キ' = 83 4C. 0x83 은 UTF-8 lead 로 유효하지 않음(0x80-0xC1 배제) → reject.
        byte[] data = bytes('i', 'd', '\n', 0x83, 0x4C, '\n');
        CsvInputGuard.Result r = CsvInputGuard.inspect(data);
        assertFalse(r.ok(), "Shift-JIS 바이트는 invalid UTF-8 로 reject 돼야 한다");
        assertTrue(r.reason().contains("lead byte"));
    }

    @Test
    void overlong_rejected() {
        // C0 80 = overlong NUL. 0xC0 은 invalid lead(< 0xC2) → reject.
        assertFalse(CsvInputGuard.inspect(bytes('a', 0xC0, 0x80)).ok());
    }

    @Test
    void surrogate_rejected() {
        // ED A0 80 = U+D800 (surrogate). 0xED 다음 continuation 은 80-9F 만 허용 → A0 은 reject.
        CsvInputGuard.Result r = CsvInputGuard.inspect(bytes('a', 0xED, 0xA0, 0x80));
        assertFalse(r.ok(), "surrogate 코드포인트는 reject");
        assertTrue(r.reason().contains("continuation"));
    }

    @Test
    void truncatedSequence_rejected() {
        // E3 82 (3-byte 시퀀스인데 continuation 1개 부족) → EOF 에서 truncated.
        CsvInputGuard.Result r = CsvInputGuard.inspect(bytes('a', 0xE3, 0x82));
        assertFalse(r.ok());
        assertTrue(r.reason().contains("truncated"));
    }

    @Test
    void loneContinuation_rejected() {
        // 80 (lead 없이 등장한 continuation) → invalid lead.
        assertFalse(CsvInputGuard.inspect(bytes('a', 0x80)).ok());
    }

    @Test
    void emptyInput_passes() {
        assertTrue(CsvInputGuard.inspect(new byte[0]).ok());
    }
}

package com.ksinfo.modernize_pro_data.coordinator.worker.source;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** EucJpSourceReader — EUC-JP 디코드 + invalid 바이트 fail-fast (Docker 불필요, ShiftJis 대칭). */
class EucJpSourceReaderTest {

    private final EucJpSourceReader reader = new EucJpSourceReader();

    @Test
    void supports_eucAliases_notOthers() {
        assertTrue(reader.supports("EUC-JP"));
        assertTrue(reader.supports("eucjp"));
        assertTrue(reader.supports("EUC_JP"));
        assertTrue(reader.supports("JA16EUC"));
        assertFalse(reader.supports("UTF-8"));
        assertFalse(reader.supports("Shift_JIS"));
        assertFalse(reader.supports(null));
    }

    @Test
    void validEucJp_decodedToUtf8(@TempDir Path dir) throws Exception {
        // "id,name\n1,あ\n" — あ=U+3042 (EUC-JP A4 A2)
        ByteArrayOutputStream b = new ByteArrayOutputStream();
        b.write("id,name\n1,".getBytes(StandardCharsets.US_ASCII));
        b.write(new byte[]{(byte) 0xA4, (byte) 0xA2});   // あ
        b.write("\n".getBytes(StandardCharsets.US_ASCII));
        Path src = Files.write(dir.resolve("in.csv"), b.toByteArray());

        Path out = reader.toUtf8(src, "EUC-JP", dir.resolve("work"));
        assertEquals("id,name\n1,あ\n", Files.readString(out, StandardCharsets.UTF_8));
    }

    @Test
    void invalidByte_failsFastWithOffset(@TempDir Path dir) throws Exception {
        // 0xA4(lead) + 0x20(공백 — 유효 trail 아님) → malformed. 앞에 'ab' → offset 2.
        byte[] bad = new byte[]{'a', 'b', (byte) 0xA4, (byte) 0x20, 'c'};
        Path src = Files.write(dir.resolve("bad.csv"), bad);

        IOException ex = assertThrows(IOException.class,
                () -> reader.toUtf8(src, "EUC-JP", dir.resolve("work")));
        assertTrue(ex.getMessage().contains("byte offset"), ex.getMessage());
        assertTrue(ex.getMessage().contains("2"), "malformed 위치(offset 2): " + ex.getMessage());
    }
}

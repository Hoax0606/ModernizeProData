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
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** ShiftJisSourceReader — MS932 디코드 + invalid 바이트 fail-fast (Docker 불필요). */
class ShiftJisSourceReaderTest {

    private final ShiftJisSourceReader reader = new ShiftJisSourceReader();

    @Test
    void supports_sjisAliases_notUtf8() {
        assertTrue(reader.supports("Shift_JIS"));
        assertTrue(reader.supports("sjis"));
        assertTrue(reader.supports("MS932"));
        assertTrue(reader.supports("windows-31j"));
        assertTrue(reader.supports("CP932"));
        assertFalse(reader.supports("UTF-8"));
        assertFalse(reader.supports(null));
        assertFalse(reader.supports("EUC-JP"));
    }

    @Test
    void validSjis_decodedToUtf8(@TempDir Path dir) throws Exception {
        // "id,name\n1,あ\n2,髙\n" — あ=U+3042(SJIS 82 A0), 髙=U+9AD9(MS932 벤더확장 FB FC)
        ByteArrayOutputStream b = new ByteArrayOutputStream();
        b.write("id,name\n1,".getBytes(StandardCharsets.US_ASCII));
        b.write(new byte[]{(byte) 0x82, (byte) 0xA0});   // あ
        b.write("\n2,".getBytes(StandardCharsets.US_ASCII));
        b.write(new byte[]{(byte) 0xFB, (byte) 0xFC});   // 髙 (機種依存文字 — strict SJIS 는 오거부, MS932 는 OK)
        b.write("\n".getBytes(StandardCharsets.US_ASCII));
        Path src = Files.write(dir.resolve("in.csv"), b.toByteArray());

        Path out = reader.toUtf8(src, "Shift_JIS", dir.resolve("work"));
        String utf8 = Files.readString(out, StandardCharsets.UTF_8);
        assertEquals("id,name\n1,あ\n2,髙\n", utf8);
    }

    @Test
    void invalidTrailByte_failsFastWithOffset(@TempDir Path dir) throws Exception {
        // 0x82(lead) + 0x20(공백 — 유효 trail 아님) → malformed. 앞에 'ab' 2 byte → offset 2.
        byte[] bad = new byte[]{'a', 'b', (byte) 0x82, (byte) 0x20, 'c'};
        Path src = Files.write(dir.resolve("bad.csv"), bad);

        IOException ex = assertThrows(IOException.class,
                () -> reader.toUtf8(src, "SJIS", dir.resolve("work")));
        assertTrue(ex.getMessage().contains("byte offset"), ex.getMessage());
        assertTrue(ex.getMessage().contains("2"), "malformed 바이트 위치(offset 2): " + ex.getMessage());
    }

    @Test
    void passthrough_returnsSameFileForUtf8(@TempDir Path dir) throws Exception {
        Utf8PassthroughSourceReader pass = new Utf8PassthroughSourceReader();
        assertTrue(pass.supports("UTF-8"));
        assertTrue(pass.supports(null));
        Path src = Files.write(dir.resolve("u.csv"), "id\n1\n".getBytes(StandardCharsets.UTF_8));
        assertSame(src, pass.toUtf8(src, "UTF-8", dir));   // no-op, 원본 그대로
    }
}

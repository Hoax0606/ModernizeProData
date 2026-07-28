package com.ksinfo.modernize_pro_data.coordinator.load.charset;

import org.junit.jupiter.api.Test;

import java.nio.charset.Charset;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** TargetCharsetMapper — NLS/친숙 별칭 → TargetCharset 해석 + 미지원 fail-fast (Docker 불필요). */
class TargetCharsetMapperTest {

    @Test
    void resolvesUtf8Aliases() {
        for (String s : new String[]{"AL32UTF8", "al32utf8", "UTF-8", "utf8", " UTF8 ", "unicode"}) {
            assertEquals(TargetCharset.AL32UTF8, TargetCharsetMapper.resolve(s), "alias=" + s);
        }
        assertEquals(Charset.forName("UTF-8"), TargetCharset.AL32UTF8.charset());
        assertEquals("AL32UTF8", TargetCharset.AL32UTF8.sqlLoaderToken());
        assertEquals("AL32UTF8", TargetCharset.AL32UTF8.nlsName());
    }

    @Test
    void resolvesShiftJisAliasesToMs932() {
        for (String s : new String[]{"JA16SJIS", "Shift_JIS", "SHIFT-JIS", "sjis", "MS932", "windows-31j", "CP932"}) {
            assertEquals(TargetCharset.JA16SJIS, TargetCharsetMapper.resolve(s), "alias=" + s);
        }
        // strict SJIS 오거부 회피 위해 Java 측은 superset windows-31j.
        assertEquals(Charset.forName("windows-31j"), TargetCharset.JA16SJIS.charset());
        assertEquals("JA16SJIS", TargetCharset.JA16SJIS.sqlLoaderToken());
    }

    @Test
    void resolvesEucJpAliases() {
        for (String s : new String[]{"JA16EUC", "EUC-JP", "eucjp", "EUC_JP"}) {
            assertEquals(TargetCharset.JA16EUC, TargetCharsetMapper.resolve(s), "alias=" + s);
        }
        assertEquals(Charset.forName("EUC-JP"), TargetCharset.JA16EUC.charset());
        assertEquals("JA16EUC", TargetCharset.JA16EUC.sqlLoaderToken());
    }

    @Test
    void unsupportedFailsFast() {
        assertThrows(IllegalArgumentException.class, () -> TargetCharsetMapper.resolve("KOI8-R"));
        assertThrows(IllegalArgumentException.class, () -> TargetCharsetMapper.resolve("EBCDIC"));
    }

    @Test
    void blankIsNotSupported() {
        assertFalse(TargetCharsetMapper.isSupported(null));
        assertFalse(TargetCharsetMapper.isSupported(""));
        assertFalse(TargetCharsetMapper.isSupported("  "));
        assertTrue(TargetCharsetMapper.isSupported("JA16SJIS"));
    }
}

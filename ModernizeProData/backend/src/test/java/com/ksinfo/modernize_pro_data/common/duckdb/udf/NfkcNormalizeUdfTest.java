package com.ksinfo.modernize_pro_data.common.duckdb.udf;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

/**
 * NfkcNormalizeUdf — 유니코드 NFKC 정규화. ValidationReportService checksum canonical 비교에서
 * AS-IS(DuckDB)/TO-BE(PG) 가 화면상 같지만 코드포인트 다를 때(NFD/NFC, CJK 호환문자) 통일용.
 */
class NfkcNormalizeUdfTest {

    @Test
    void nfdEqualsNfcAfterNormalize() {
        String nfd = "が";   // か + ゛ (NFD 분해형)
        String nfc = "が";          // が (NFC 결합형)
        assertEquals(NfkcNormalizeUdf.apply(nfc), NfkcNormalizeUdf.apply(nfd),
                "NFD 와 NFC 의 'が' 는 NFKC 후 같아야 한다");
        assertEquals("が", NfkcNormalizeUdf.apply(nfd));
    }

    @Test
    void cjkCompatibilityFolded() {
        assertEquals("1", NfkcNormalizeUdf.apply("①"));        // ① → 1
        assertEquals("(株)", NfkcNormalizeUdf.apply("㈱"));      // ㈱ → (株)
        assertEquals("fi", NfkcNormalizeUdf.apply("ﬁ"));        // ﬁ ligature → fi
    }

    @Test
    void plainAsciiUnchanged() {
        assertEquals("CUST_ID", NfkcNormalizeUdf.apply("CUST_ID"));
    }

    @Test
    void nullInNullOut() {
        assertNull(NfkcNormalizeUdf.apply(null));
    }
}

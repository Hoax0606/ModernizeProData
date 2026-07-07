package com.ksinfo.modernize_pro_data.common.duckdb.udf;

import org.duckdb.DuckDBFunctions;

import java.sql.Connection;
import java.sql.SQLException;
import java.text.Normalizer;
import java.util.function.Function;

/**
 * nfkc_normalize(VARCHAR) → VARCHAR
 *
 * 문자열을 유니코드 NFKC(호환 정규화)로 변환. DuckDB native 는 nfc_normalize 만 있어,
 * PG 의 {@code normalize(text, NFKC)} 와 짝을 맞추기 위해 Java {@link Normalizer} 로 제공.
 *
 * 용도: ValidationReportService 의 checksum canonical 비교. AS-IS(DuckDB)와 TO-BE(PG) 가
 * 화면상 같지만 코드포인트가 다른 경우(예: NFD 'か'+'゛' vs NFC 'が', 호환문자 ① vs 1,
 * ㈱ vs (株))를 양쪽 NFKC 로 통일해 비교 → 정규화 차이뿐이면 FAIL 대신 WARN 으로 떨어진다.
 * NFKC 는 NFC 를 포함하므로 NFC/NFD 차이와 CJK 호환문자 차이를 한 번에 흡수한다.
 *
 *   "か" + "゛" (NFD)  → "が"
 *   "①"               → "1"
 *   "㈱"              → "(株)"
 *   null              → null
 */
public final class NfkcNormalizeUdf {

    private NfkcNormalizeUdf() {}

    public static void register(Connection conn) throws SQLException {
        DuckDBFunctions.scalarFunction()
                .withName("nfkc_normalize")
                .withParameter(String.class)
                .withReturnType(String.class)
                .withFunction((Function<String, String>) NfkcNormalizeUdf::apply)
                .withNullInNullOut()
                .register(conn);
    }

    static String apply(String s) {
        if (s == null) return null;
        return Normalizer.normalize(s, Normalizer.Form.NFKC);
    }
}

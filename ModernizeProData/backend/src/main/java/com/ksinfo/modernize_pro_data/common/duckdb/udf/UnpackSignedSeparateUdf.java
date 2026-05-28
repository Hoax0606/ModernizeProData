package com.ksinfo.modernize_pro_data.common.duckdb.udf;

import org.duckdb.DuckDBFunctions;

import java.sql.Connection;
import java.sql.SQLException;
import java.util.function.Function;

/**
 * unpack_signed_separate(VARCHAR raw) → VARCHAR
 *
 * COBOL `SIGN IS LEADING/TRAILING SEPARATE` — 부호가 **별도 문자**로
 * 숫자 문자열 앞 또는 뒤에 붙은 형태. 부호 위치는 입력에서 자동 감지.
 *
 *   "+12345"  → "12345"
 *   "-12345"  → "-12345"
 *   "12345+"  → "12345"
 *   "12345-"  → "-12345"
 *   "12345"   → "12345"   (부호 없음 = 양수)
 *   "+12345-" → null       (모호 — 양끝에 부호)
 *   "abc"     → null
 *   null      → null
 *
 * Overpunch / Embedded sign (zone-encoded `{`, `A`-`I`, `}`, `J`-`R`) 은
 * 별도 UDF `unpack_overpunch` 가 처리한다.
 */
public final class UnpackSignedSeparateUdf {

    private UnpackSignedSeparateUdf() {}

    public static void register(Connection conn) throws SQLException {
        DuckDBFunctions.scalarFunction()
                .withName("unpack_signed_separate")
                .withParameter(String.class)
                .withReturnType(String.class)
                .withFunction((Function<String, String>) UnpackSignedSeparateUdf::apply)
                .withNullInNullOut()
                .register(conn);
    }

    static String apply(String raw) {
        if (raw == null) return null;
        String s = raw.trim();
        if (s.isEmpty()) return null;
        char first = s.charAt(0);
        char last = s.charAt(s.length() - 1);
        boolean leadingSign = (first == '+' || first == '-');
        boolean trailingSign = (last == '+' || last == '-');
        if (leadingSign && trailingSign) return null;  // 양끝 부호 = 모호

        String digits;
        boolean negative;
        if (leadingSign) {
            digits = s.substring(1);
            negative = (first == '-');
        } else if (trailingSign) {
            digits = s.substring(0, s.length() - 1);
            negative = (last == '-');
        } else {
            digits = s;
            negative = false;
        }
        if (digits.isEmpty() || !digits.matches("\\d+")) return null;
        return (negative ? "-" : "") + digits;
    }
}

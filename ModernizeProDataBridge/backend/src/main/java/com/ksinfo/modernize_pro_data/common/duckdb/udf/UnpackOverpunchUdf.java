package com.ksinfo.modernize_pro_data.common.duckdb.udf;

import org.duckdb.DuckDBFunctions;

import java.sql.Connection;
import java.sql.SQLException;
import java.util.function.Function;

/**
 * unpack_overpunch(VARCHAR raw) → VARCHAR
 *
 * COBOL `SIGN IS TRAILING` (zone-encoded embedded sign). 부호와 마지막
 * digit 이 한 문자에 합쳐져 인코딩된 형태. EBCDIC → ASCII 변환 후
 * 그대로 보이는 문자:
 *
 *   양수: `{` = 0, `A`~`I` = 1~9        (EBCDIC zone C)
 *   음수: `}` = 0, `J`~`R` = 1~9        (EBCDIC zone D)
 *
 *   "1234{"  → "12340"
 *   "1234A"  → "12341"
 *   "1234I"  → "12349"
 *   "1234}"  → "-12340"
 *   "1234J"  → "-12341"
 *   "1234R"  → "-12349"
 *   "12345"  → "12345"   (마지막이 일반 digit — 부호 없는 케이스로 통과)
 *   "1234X"  → null      (overpunch 문자 아님)
 *   "abc"    → null
 *   null     → null
 *
 * Leading overpunch (첫 문자에 부호 인코딩) 는 SIGN IS LEADING 형태로
 * 덜 흔하므로 일단 trailing 만 처리. 필요 시 별도 UDF 로 분리.
 */
public final class UnpackOverpunchUdf {

    private UnpackOverpunchUdf() {}

    public static void register(Connection conn) throws SQLException {
        DuckDBFunctions.scalarFunction()
                .withName("unpack_overpunch")
                .withParameter(String.class)
                .withReturnType(String.class)
                .withFunction((Function<String, String>) UnpackOverpunchUdf::apply)
                .withNullInNullOut()
                .register(conn);
    }

    static String apply(String raw) {
        if (raw == null) return null;
        String s = raw.trim();
        if (s.isEmpty()) return null;
        char last = s.charAt(s.length() - 1);
        String head = s.substring(0, s.length() - 1);
        if (!head.matches("\\d*")) return null;

        // 마지막이 일반 digit — 부호 없는 케이스로 통과 (입력 전체가 숫자여야)
        if (last >= '0' && last <= '9') {
            return s.matches("\\d+") ? s : null;
        }

        int sign;
        int digit;
        switch (last) {
            case '{': sign = 1;  digit = 0; break;
            case 'A': sign = 1;  digit = 1; break;
            case 'B': sign = 1;  digit = 2; break;
            case 'C': sign = 1;  digit = 3; break;
            case 'D': sign = 1;  digit = 4; break;
            case 'E': sign = 1;  digit = 5; break;
            case 'F': sign = 1;  digit = 6; break;
            case 'G': sign = 1;  digit = 7; break;
            case 'H': sign = 1;  digit = 8; break;
            case 'I': sign = 1;  digit = 9; break;
            case '}': sign = -1; digit = 0; break;
            case 'J': sign = -1; digit = 1; break;
            case 'K': sign = -1; digit = 2; break;
            case 'L': sign = -1; digit = 3; break;
            case 'M': sign = -1; digit = 4; break;
            case 'N': sign = -1; digit = 5; break;
            case 'O': sign = -1; digit = 6; break;
            case 'P': sign = -1; digit = 7; break;
            case 'Q': sign = -1; digit = 8; break;
            case 'R': sign = -1; digit = 9; break;
            default: return null;
        }
        String digits = head + digit;
        return (sign < 0 ? "-" : "") + digits;
    }
}

package com.ksinfo.modernize_pro_data.common.duckdb.udf;

import org.duckdb.DuckDBFunctions;

import java.sql.Connection;
import java.sql.SQLException;
import java.util.function.Function;

/**
 * mask_phone(VARCHAR phone) → VARCHAR
 *
 * 전화번호의 가운데 디지트를 '*' 로 마스킹. 앞 3 자리 + 마지막 4 자리는 그대로 유지.
 * 하이픈·공백 같은 구분자는 위치 그대로 보존.
 *
 *   "090-1234-5678"  → "090-****-5678"
 *   "03-1234-5678"   → "03*-****-5678"   (앞 3자가 03 + 첫 디지트까지 보존)
 *   "09012345678"    → "090****5678"
 *   "1234"           → "1234"            (디지트 7 미만 — 마스킹 의미 없음, 원본)
 *   null             → null
 *
 * 일본 dial-plan 의 다양한 자릿수 (03, 045, 090 등) 를 정확히 다루려면 별도 alg
 * 필요. PoC 시연용으로는 "앞 3 + 뒤 4 보존" 정책으로 충분.
 */
public final class MaskPhoneUdf {

    private MaskPhoneUdf() {}

    private static final int KEEP_START = 3;
    private static final int KEEP_END   = 4;
    private static final int MIN_DIGITS = KEEP_START + KEEP_END;  // 7 미만이면 마스킹 안 함

    public static void register(Connection conn) throws SQLException {
        DuckDBFunctions.scalarFunction()
                .withName("mask_phone")
                .withParameter(String.class)
                .withReturnType(String.class)
                .withFunction((Function<String, String>) MaskPhoneUdf::apply)
                .withNullInNullOut()
                .register(conn);
    }

    static String apply(String phone) {
        if (phone == null) return null;
        int totalDigits = 0;
        for (char c : phone.toCharArray()) if (Character.isDigit(c)) totalDigits++;
        if (totalDigits < MIN_DIGITS) return phone;

        StringBuilder sb = new StringBuilder(phone.length());
        int seen = 0;
        int maskEndIdx = totalDigits - KEEP_END;   // seen 이 이 값까지일 때 마스킹
        for (char c : phone.toCharArray()) {
            if (Character.isDigit(c)) {
                seen++;
                if (seen > KEEP_START && seen <= maskEndIdx) {
                    sb.append('*');
                } else {
                    sb.append(c);
                }
            } else {
                sb.append(c);  // 구분자 유지
            }
        }
        return sb.toString();
    }
}

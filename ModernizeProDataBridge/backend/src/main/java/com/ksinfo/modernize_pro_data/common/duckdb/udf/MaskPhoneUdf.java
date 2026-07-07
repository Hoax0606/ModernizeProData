package com.ksinfo.modernize_pro_data.common.duckdb.udf;

import org.duckdb.DuckDBFunctions;

import java.sql.Connection;
import java.sql.SQLException;
import java.util.function.Function;

/**
 * mask_phone(VARCHAR phone) → VARCHAR
 *
 * 전화번호의 가운데 디지트를 '*' 로 마스킹.
 *   - 구분자 (하이픈/공백) 가 있는 경우 → **첫 그룹** + 마지막 4 디지트 보존
 *   - 구분자 없는 raw 디지트 → 앞 3 + 마지막 4 디지트 보존
 *
 * 일본 dial-plan 의 다양한 자릿수 (03 / 045 / 090 등) 가 자연스럽게 처리됨.
 *
 *   "090-1234-5678"  → "090-****-5678"   (첫 그룹 090 보존)
 *   "03-1234-5678"   → "03-****-5678"    (첫 그룹 03 보존)
 *   "045-123-4567"   → "045-***-4567"    (첫 그룹 045 보존)
 *   "09012345678"    → "090****5678"     (구분자 없음 — 앞 3 보존)
 *   "1234567"        → "***4567"         (구분자 없음 + 7자 — 마지막 4 만 보존)
 *   "12345"          → "12345"           (디지트 7 미만 — 마스킹 안 함)
 *   null             → null
 */
public final class MaskPhoneUdf {

    private MaskPhoneUdf() {}

    private static final int KEEP_START_NO_SEP = 3;   // 구분자 없을 때 앞 보존 자릿수
    private static final int KEEP_END          = 4;   // 마지막 보존 자릿수
    private static final int MIN_DIGITS        = 7;   // 그보다 짧으면 마스킹 안 함

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

        // 첫 구분자 (하이픈/공백 등 non-digit) 위치 — 없으면 -1
        int firstSepIdx = -1;
        for (int i = 0; i < phone.length(); i++) {
            if (!Character.isDigit(phone.charAt(i))) { firstSepIdx = i; break; }
        }
        final int maskEnd = totalDigits - KEEP_END;

        StringBuilder sb = new StringBuilder(phone.length());
        int seen = 0;
        for (int i = 0; i < phone.length(); i++) {
            char c = phone.charAt(i);
            if (Character.isDigit(c)) {
                seen++;
                boolean keep;
                if (firstSepIdx >= 0) {
                    // 구분자 있음 — 첫 그룹 (구분자 앞) 보존 + 마지막 KEEP_END 보존
                    keep = (i < firstSepIdx) || (seen > maskEnd);
                } else {
                    // 구분자 없음 — 앞 KEEP_START_NO_SEP + 마지막 KEEP_END 보존
                    keep = (seen <= KEEP_START_NO_SEP) || (seen > maskEnd);
                }
                sb.append(keep ? c : '*');
            } else {
                sb.append(c);  // 구분자 위치 보존
            }
        }
        return sb.toString();
    }
}

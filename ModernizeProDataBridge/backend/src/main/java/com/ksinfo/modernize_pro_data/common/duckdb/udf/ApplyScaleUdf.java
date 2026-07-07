package com.ksinfo.modernize_pro_data.common.duckdb.udf;

import org.duckdb.DuckDBFunctions;

import java.math.BigDecimal;
import java.sql.Connection;
import java.sql.SQLException;
import java.util.function.BiFunction;

/**
 * apply_scale(VARCHAR raw_hex, INTEGER scale) → VARCHAR
 *
 * COMP-3 (Packed Decimal) hex 문자열을 unpack 후 scale 만큼 소수점 적용,
 * **정확한 문자열로 반환**한다. 사용자가 row editor 에서 명시적으로 CAST 해야 함:
 *
 *   CAST(apply_scale(e.SALARY_RAW, 2) AS DECIMAL(15,2))     -- 금액
 *   CAST(apply_scale(e.COUNT_RAW, 0)  AS INTEGER)            -- 정수
 *
 * VARCHAR 반환 이유: DuckDB UDF 시그니처는 컴파일 타임 고정이라 generic
 * BigDecimal 반환 시 default scale (DECIMAL(38, 11) 등) 으로 trailing zero
 * 가 붙는다. VARCHAR + 사용자 CAST 패턴이 가장 유연 + 정확.
 *
 *   "12345C"  → "123.45"   (scale=2)
 *   "0000045D" → "-0.45"   (부호 D = 음수)
 *   "12345"    → "123.45"  (scale=2, 부호 nibble 없음 → 양수로 간주)
 *   "INVALID"  → null   (Quarantine)
 *   null       → null
 *
 * 부호 nibble (마지막 hex 자리):
 *   C / F / A / E → 양수
 *   D / B         → 음수
 *   기타          → 부호 nibble 없는 plain 숫자열 — 그대로 unpack
 */
public final class ApplyScaleUdf {

    private ApplyScaleUdf() {}

    public static void register(Connection conn) throws SQLException {
        DuckDBFunctions.scalarFunction()
                .withName("apply_scale")
                .withParameters(String.class, Integer.class)
                .withReturnType(String.class)
                .withFunction((BiFunction<String, Integer, String>) ApplyScaleUdf::apply)
                .withNullInNullOut()
                .register(conn);
    }

    static String apply(String rawHex, Integer scale) {
        if (rawHex == null || scale == null) return null;
        try {
            String h = rawHex.trim();
            if (h.isEmpty()) return null;
            int signum = 1;
            String digits = h;
            char last = Character.toUpperCase(h.charAt(h.length() - 1));
            if (last == 'C' || last == 'F' || last == 'A' || last == 'E') {
                signum = 1;
                digits = h.substring(0, h.length() - 1);
            } else if (last == 'D' || last == 'B') {
                signum = -1;
                digits = h.substring(0, h.length() - 1);
            }
            // 부호 nibble 이 없는 plain 숫자열 ("12345") 도 허용 — digits 그대로
            if (digits.isEmpty() || !digits.matches("\\d+")) return null;
            BigDecimal raw = new BigDecimal(digits).movePointLeft(scale);
            if (signum < 0) raw = raw.negate();
            // toPlainString() — scientific notation 없이 정확한 자릿수만.
            // trailing zero 없음 (123.45, -0.45).
            return raw.toPlainString();
        } catch (Exception e) {
            // Notion §3-1: 예외 throw 금지 — null 반환으로 Quarantine 분기
            return null;
        }
    }
}

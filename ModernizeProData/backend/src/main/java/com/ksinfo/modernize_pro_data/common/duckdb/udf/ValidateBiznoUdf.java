package com.ksinfo.modernize_pro_data.common.duckdb.udf;

import org.duckdb.DuckDBFunctions;

import java.sql.Connection;
import java.sql.SQLException;
import java.util.function.Function;

/**
 * validate_bizno(VARCHAR bizno) → VARCHAR
 *
 * 일본 法人番号 (13 자리) 의 체크디지트를 검증. 유효하면 정규화된 13 자리 문자열을
 * 반환하고, 무효하면 null 을 반환 (Quarantine 분기로 흘러감).
 *
 * 알고리즘 (国税庁 공식):
 *   첫 자리 (Q1) = 체크디지트
 *   Q1 = 9 − (Σ(n=2..13) Q_n × P_n) mod 9
 *   P_n = 1 if n is even, 2 if n is odd
 *
 *   "1234567890123" (13 자리)              → 체크디지트 일치 시 그대로
 *   "1234-5678-9012-3" (구분자)             → 구분자 제거 후 검증
 *   "12345"           (자릿수 부족)         → null
 *   "ABCDEFGHIJKLM"   (숫자 외 문자)        → null
 *   null                                   → null
 *
 * 한국 사업자번호 (10자리, modulo 10 가중치) 는 별도 UDF (`validate_brn_kr`)
 * 로 분리 권장 — 알고리즘이 완전히 다름.
 */
public final class ValidateBiznoUdf {

    private ValidateBiznoUdf() {}

    public static void register(Connection conn) throws SQLException {
        DuckDBFunctions.scalarFunction()
                .withName("validate_bizno")
                .withParameter(String.class)
                .withReturnType(String.class)
                .withFunction((Function<String, String>) ValidateBiznoUdf::apply)
                .withNullInNullOut()
                .register(conn);
    }

    static String apply(String bizno) {
        if (bizno == null) return null;
        String digits = bizno.trim().replaceAll("[\\s-]", "");
        if (!digits.matches("\\d{13}")) return null;
        try {
            int sum = 0;
            for (int n = 2; n <= 13; n++) {
                int qn = digits.charAt(n - 1) - '0';
                int pn = (n % 2 == 0) ? 1 : 2;
                sum += qn * pn;
            }
            int expected = 9 - (sum % 9);
            if (expected == 9) expected = 0;  // mod 9 = 0 → 체크디지트 0 (보정)
            int actual = digits.charAt(0) - '0';
            return (expected == actual) ? digits : null;
        } catch (Exception e) {
            return null;
        }
    }
}

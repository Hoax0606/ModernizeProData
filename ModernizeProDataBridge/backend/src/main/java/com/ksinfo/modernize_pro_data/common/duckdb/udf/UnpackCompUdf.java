package com.ksinfo.modernize_pro_data.common.duckdb.udf;

import org.duckdb.DuckDBFunctions;

import java.math.BigDecimal;
import java.math.BigInteger;
import java.sql.Connection;
import java.sql.SQLException;
import java.util.function.BiFunction;

/**
 * unpack_comp(VARCHAR raw_hex, INTEGER scale) → VARCHAR
 *
 * COBOL COMP (COMP-4, Binary Integer) — 빅엔디언 2's complement signed 정수.
 * hex 입력 길이로 자동 자릿수 판단:
 *   - 4 자  (2 byte) → short  ( -32,768 ~ 32,767)
 *   - 8 자  (4 byte) → int    ( -2.1G ~ 2.1G)
 *   - 16 자 (8 byte) → long   (full 64-bit signed)
 *
 * COBOL `PIC S9(7)V99 COMP` 처럼 implied decimal (scale) 지정 가능.
 * apply_scale 와 같은 VARCHAR 반환 + 사용자 CAST 패턴 — UDF 반환 타입이
 * 컴파일 타임 고정이라 BigDecimal 기본 scale 의 trailing zero 문제 회피.
 *
 *   unpack_comp("0064", 0)     → "100"           (signed 16-bit)
 *   unpack_comp("FFFF", 0)     → "-1"
 *   unpack_comp("00000064", 2) → "1.00"          (signed 32-bit + scale=2)
 *   unpack_comp("80000000", 0) → "-2147483648"   (signed 32-bit min)
 *   unpack_comp("0064", -1)    → "1000"          (음수 scale 도 허용 — movePointRight 효과)
 *   unpack_comp("12", 0)       → null            (hex 길이 2/4/8/16 만 허용 — 2 는 거부)
 *   null / invalid hex         → null
 */
public final class UnpackCompUdf {

    private UnpackCompUdf() {}

    public static void register(Connection conn) throws SQLException {
        DuckDBFunctions.scalarFunction()
                .withName("unpack_comp")
                .withParameters(String.class, Integer.class)
                .withReturnType(String.class)
                .withFunction((BiFunction<String, Integer, String>) UnpackCompUdf::apply)
                .withNullInNullOut()
                .register(conn);
    }

    static String apply(String rawHex, Integer scale) {
        if (rawHex == null || scale == null) return null;
        try {
            String h = rawHex.trim().toUpperCase();
            if (h.isEmpty() || !h.matches("[0-9A-F]+")) return null;
            int len = h.length();
            if (len != 4 && len != 8 && len != 16) return null;
            byte[] bytes = new byte[len / 2];
            for (int i = 0; i < bytes.length; i++) {
                bytes[i] = (byte) Integer.parseInt(h.substring(i * 2, i * 2 + 2), 16);
            }
            // BigInteger(byte[]) — signed (2's complement) 해석
            BigInteger bi = new BigInteger(bytes);
            BigDecimal bd = new BigDecimal(bi).movePointLeft(scale);
            return bd.toPlainString();
        } catch (Exception e) {
            return null;
        }
    }
}

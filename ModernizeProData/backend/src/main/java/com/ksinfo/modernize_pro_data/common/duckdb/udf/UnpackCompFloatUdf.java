package com.ksinfo.modernize_pro_data.common.duckdb.udf;

import org.duckdb.DuckDBFunctions;

import java.sql.Connection;
import java.sql.SQLException;
import java.util.function.Function;

/**
 * unpack_comp_float(VARCHAR raw_hex) → DOUBLE
 *
 * IBM Hexadecimal Floating Point (HFP) — COMP-1 / COMP-2.
 * hex 길이로 자동 분기:
 *   -  8 자 ( 4 byte) → COMP-1 (single precision)
 *   - 16 자 ( 8 byte) → COMP-2 (double precision)
 *
 * 비트 layout (둘 다 첫 비트가 sign):
 *   sign(1) | exponent(7, excess-64) | fraction(24 or 56)
 *   value = (-1)^sign × fraction / 16^digits × 16^(exp − 64)
 *
 * IEEE 754 와 달리 base 가 16 (hex digit 단위 normalize) — 정확도 손실 가능.
 *
 *   unpack_comp_float("41100000")          →  1.0                (COMP-1)
 *   unpack_comp_float("C1100000")          → -1.0
 *   unpack_comp_float("4110000000000000")  →  1.0                (COMP-2)
 *   unpack_comp_float("00000000")          →  0.0                (true zero)
 *   unpack_comp_float("ZZZZ")              →  null
 *   null                                   →  null
 */
public final class UnpackCompFloatUdf {

    private UnpackCompFloatUdf() {}

    public static void register(Connection conn) throws SQLException {
        DuckDBFunctions.scalarFunction()
                .withName("unpack_comp_float")
                .withParameter(String.class)
                .withReturnType(Double.class)
                .withFunction((Function<String, Double>) UnpackCompFloatUdf::apply)
                .withNullInNullOut()
                .register(conn);
    }

    static Double apply(String rawHex) {
        if (rawHex == null) return null;
        try {
            String h = rawHex.trim().toUpperCase();
            if (h.isEmpty() || !h.matches("[0-9A-F]+")) return null;
            if (h.length() == 8) return decode32(h);
            if (h.length() == 16) return decode64(h);
            return null;
        } catch (Exception e) {
            return null;
        }
    }

    private static Double decode32(String h) {
        long bits = Long.parseLong(h, 16);
        int sign = (int) ((bits >>> 31) & 0x1);
        int exp  = (int) ((bits >>> 24) & 0x7F);
        long frac = bits & 0x00FFFFFFL;
        if (exp == 0 && frac == 0) return 0.0;
        // mantissa = frac / 16^6 = frac / 2^24
        double mantissa = frac / Math.pow(2, 24);
        double value = mantissa * Math.pow(16, exp - 64);
        return sign == 0 ? value : -value;
    }

    private static Double decode64(String h) {
        long bits = Long.parseUnsignedLong(h, 16);
        int sign = (int) ((bits >>> 63) & 0x1);
        int exp  = (int) ((bits >>> 56) & 0x7F);
        long frac = bits & 0x00FFFFFFFFFFFFFFL;
        if (exp == 0 && frac == 0) return 0.0;
        // mantissa = frac / 16^14 = frac / 2^56
        double mantissa = frac / Math.pow(2, 56);
        double value = mantissa * Math.pow(16, exp - 64);
        return sign == 0 ? value : -value;
    }
}

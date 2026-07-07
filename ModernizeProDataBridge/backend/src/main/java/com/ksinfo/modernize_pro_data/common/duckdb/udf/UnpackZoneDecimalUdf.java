package com.ksinfo.modernize_pro_data.common.duckdb.udf;

import org.duckdb.DuckDBFunctions;

import java.sql.Connection;
import java.sql.SQLException;
import java.util.function.Function;

/**
 * unpack_zone_decimal(VARCHAR zone_hex) → VARCHAR
 *
 * IBM 메인프레임의 Zone Decimal (Display Numeric, EBCDIC) 형식 hex 문자열을
 * 정수 문자열로 unpack. COMP-3 와 달리 nibble 압축이 아니라 한 byte 당 한 자리.
 *
 * Byte 구조:
 *   상위 nibble (zone) = 디지트의 zone code
 *     - 0xF: unsigned
 *     - 마지막 byte 의 경우: 0xC/0xF/0xA/0xE = 양수, 0xD/0xB = 음수
 *   하위 nibble (digit) = 실제 숫자 (0~9)
 *
 *   "F1F2F3F4F5"   → "12345"    (unsigned)
 *   "F1F2F3F4C5"   → "12345"    (마지막 zone=C → 양수)
 *   "F1F2F3F4D5"   → "-12345"   (마지막 zone=D → 음수)
 *   "F1F2F30G"     → null       (hex 아님)
 *   "F1F2F3"       → "123"
 *   null           → null
 *
 * 한계: 실제 EBCDIC zone decimal 은 byte 시퀀스를 그대로 받아 ASCII/CP1252 변환
 * 시 특수 매핑 (`{`, `A`~`I`, `J`~`R`) 이 일어남. 이 UDF 는 hex 입력 가정 — Reader
 * 단계에서 raw byte → hex 로 정규화한 후 호출하는 것을 권장.
 */
public final class UnpackZoneDecimalUdf {

    private UnpackZoneDecimalUdf() {}

    public static void register(Connection conn) throws SQLException {
        DuckDBFunctions.scalarFunction()
                .withName("unpack_zone_decimal")
                .withParameter(String.class)
                .withReturnType(String.class)
                .withFunction((Function<String, String>) UnpackZoneDecimalUdf::apply)
                .withNullInNullOut()
                .register(conn);
    }

    static String apply(String zoneHex) {
        if (zoneHex == null) return null;
        try {
            String h = zoneHex.trim().toUpperCase();
            if (h.isEmpty() || !h.matches("[0-9A-F]+") || h.length() % 2 != 0) return null;
            StringBuilder digits = new StringBuilder(h.length() / 2);
            int signum = 1;
            int lastIdx = h.length() - 2;
            for (int i = 0; i < h.length(); i += 2) {
                char zone = h.charAt(i);
                char digit = h.charAt(i + 1);
                if (digit < '0' || digit > '9') return null;
                digits.append(digit);
                if (i == lastIdx) {
                    switch (zone) {
                        case 'C': case 'F': case 'A': case 'E': signum = 1; break;
                        case 'D': case 'B':                     signum = -1; break;
                        default: return null;
                    }
                }
            }
            return (signum < 0 ? "-" : "") + digits.toString();
        } catch (Exception e) {
            return null;
        }
    }
}

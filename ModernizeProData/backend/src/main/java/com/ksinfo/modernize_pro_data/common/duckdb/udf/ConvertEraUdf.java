package com.ksinfo.modernize_pro_data.common.duckdb.udf;

import org.duckdb.DuckDBFunctions;

import java.sql.Connection;
import java.sql.SQLException;
import java.time.LocalDate;
import java.util.Map;
import java.util.function.Function;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * convert_era(VARCHAR era_text) → DATE
 *
 * 일본 연호 표기를 서기 DATE 로 변환.
 *
 *   "令和8年5月16日"  → 2019 + (8-1) = 2026-05-16
 *   "平成元年1月8日"  → 매칭 실패 ("元" 미지원) → null
 *   "昭和64年1月7日"  → 1926 + (64-1) = 1989-01-07
 *   "INVALID"         → null
 *
 * 연호 기산년:
 *   令和(2019) / 平成(1989) / 昭和(1926) / 大正(1912) / 明治(1868)
 *
 * 매칭 실패 / 무효 날짜 / null 입력 → null 반환 (Quarantine 분기).
 */
public final class ConvertEraUdf {

    private ConvertEraUdf() {}

    private static final Pattern PATTERN =
            Pattern.compile("^(令和|平成|昭和|大正|明治)(\\d+)年(\\d+)月(\\d+)日$");

    private static final Map<String, Integer> ERA_BASE = Map.of(
            "令和", 2019,
            "平成", 1989,
            "昭和", 1926,
            "大正", 1912,
            "明治", 1868
    );

    public static void register(Connection conn) throws SQLException {
        DuckDBFunctions.scalarFunction()
                .withName("convert_era")
                .withParameter(String.class)
                .withReturnType(LocalDate.class)
                .withFunction((Function<String, LocalDate>) ConvertEraUdf::apply)
                .withNullInNullOut()
                .register(conn);
    }

    static LocalDate apply(String text) {
        if (text == null) return null;
        Matcher m = PATTERN.matcher(text.trim());
        if (!m.matches()) return null;
        Integer base = ERA_BASE.get(m.group(1));
        if (base == null) return null;
        try {
            int eraYear = Integer.parseInt(m.group(2));
            int month   = Integer.parseInt(m.group(3));
            int day     = Integer.parseInt(m.group(4));
            int year    = base + eraYear - 1;
            return LocalDate.of(year, month, day);
        } catch (Exception e) {
            return null;
        }
    }
}

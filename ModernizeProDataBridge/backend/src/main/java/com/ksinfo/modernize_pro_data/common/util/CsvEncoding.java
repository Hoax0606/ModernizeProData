package com.ksinfo.modernize_pro_data.common.util;

/**
 * site.asisEncoding → DuckDB {@code read_csv} 의 {@code encoding=} 절 변환.
 *
 * <p>ExtractStage / CheckStage 가 실행(run) 경로에서 쓰는 규칙과 동일하다. 이전엔 그 규칙이
 * 실행 stage 에만 있어, preview(SiteCsvPreviewController) 와 Trial/Report(MappingReportService)
 * 가 encoding 을 누락 → Shift-JIS CSV 를 UTF-8 로 읽어 헤더가 깨지거나 read 가 실패했다
 * (Mapping 소스 컬럼 드롭다운/자동매핑이 비는 원인). 단일 출처로 통일한다.
 *
 * <p>반환 문자열은 앞에 {@code ", "} 를 포함하므로 {@code read_csv(...옵션 + clause + )} 형태로
 * 그대로 이어붙이면 된다. UTF-8 / null / blank 는 DuckDB native 라 빈 문자열.
 */
public final class CsvEncoding {

    private CsvEncoding() {}

    /** @param asisEncoding site.asisEncoding (예: "shift_jis", "EUC-JP", "UTF-8", null) */
    public static String clause(String asisEncoding) {
        if (asisEncoding == null || asisEncoding.isBlank()) return "";
        String enc = asisEncoding.trim().toLowerCase();
        if (enc.equals("utf-8") || enc.equals("utf8")) return "";
        if (enc.equals("shift_jis") || enc.equals("shiftjis") || enc.equals("sjis")) {
            return ", encoding='shift_jis'";
        }
        if (enc.equals("euc-jp") || enc.equals("euc_jp") || enc.equals("eucjp")) {
            return ", encoding='EUC_JP'";
        }
        // pass-through — DuckDB encodings 확장이 인식 가능하면 통과, 아니면 read 시 throw.
        return ", encoding='" + asisEncoding.trim().replace("'", "''") + "'";
    }
}

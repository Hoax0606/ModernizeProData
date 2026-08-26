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

    /**
     * @param asisEncoding site.asisEncoding — 무시된다(파이프라인 입력 계약 = UTF-8, 2026-07-08).
     * @return 항상 빈 문자열. read_csv 는 UTF-8 native 로만 읽는다(encodings 확장 제거).
     *
     * <p>이전엔 shift_jis/euc-jp 를 DuckDB encodings 확장의 {@code encoding=} 으로 처리했으나,
     * 그 확장 디코더가 빌드마다 유효 바이트를 오거부하는 upstream 버그(금융권 부적합)가 있어
     * "입력을 UTF-8 로 고정 + 확장 제거" 로 방향을 바꿨다. 비-UTF-8 → UTF-8 변환은
     * Source Reader SPI 책임 — Shift_JIS / EUC-JP / EBCDIC(IBM930·939·037) reader 가 구현돼 있고,
     * 지원 reader 가 없는 인코딩은 {@link CsvInputGuard} 가 reject 한다.
     */
    public static String clause(String asisEncoding) {
        return "";
    }
}

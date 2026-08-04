package com.ksinfo.modernize_pro_data.coordinator.load.charset;

import java.util.Optional;

/**
 * 자유 형식의 타깃 문자셋 문자열(site.tobeEncoding — NLS 이름 또는 친숙 별칭)을 {@link TargetCharset} 으로 해석.
 *
 * <p>SourceReaderRegistry / DialectUtil 과 같은 정규화 철학: 입력을 trim + uppercase 한 뒤 별칭 매칭.
 */
public final class TargetCharsetMapper {

    private TargetCharsetMapper() {}

    /** 지원 여부만 확인 (blank 는 false — 타깃 charset 미지정 = PG UTF-8 기본, Oracle 아님). */
    public static boolean isSupported(String raw) {
        return find(raw).isPresent();
    }

    /** 매칭되는 {@link TargetCharset} 반환, 없으면 empty. */
    public static Optional<TargetCharset> find(String raw) {
        if (raw == null || raw.isBlank()) return Optional.empty();
        String norm = raw.trim().toUpperCase();
        for (TargetCharset tc : TargetCharset.values()) {
            if (tc.matches(norm)) return Optional.of(tc);
        }
        return Optional.empty();
    }

    /**
     * 해석하거나 {@link IllegalArgumentException} — Oracle 적재 경로에서 알 수 없는 문자셋은 조용히
     * UTF-8 로 넘기면 금융 데이터 손상 위험이라 fail-fast.
     */
    public static TargetCharset resolve(String raw) {
        return find(raw).orElseThrow(() -> new IllegalArgumentException(
                "지원하지 않는 타깃 문자셋: '" + raw + "'. 지원: AL32UTF8/UTF-8, JA16SJIS/Shift_JIS, JA16EUC/EUC-JP"));
    }
}

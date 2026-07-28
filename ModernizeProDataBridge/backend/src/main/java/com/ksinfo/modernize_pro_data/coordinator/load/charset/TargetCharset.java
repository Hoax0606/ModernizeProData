package com.ksinfo.modernize_pro_data.coordinator.load.charset;

import java.nio.charset.Charset;
import java.util.Set;

/**
 * B2 Oracle 적재가 지원하는 타깃 문자셋 — Oracle {@code NLS_CHARACTERSET} ↔ Java {@link Charset} ↔
 * SQL*Loader {@code CHARACTERSET} 토큰의 3-way 매핑 단위.
 *
 * <p>흐름상 위치: DuckDB(UTF-8 내부) → {@link TargetFileEncoder} 가 이 charset 으로 {@code .dat} 파일
 * 인코딩 → sqlldr 가 같은 {@code sqlLoaderToken} 으로 읽어 Oracle(자기 NLS)에 저장.
 *
 * <p>지원 집합은 일본 금융권 이행 실무 3종으로 한정 (계획서 R5):
 * <ul>
 *   <li>{@link #AL32UTF8} — 유니코드 (신규 표준 이행처)</li>
 *   <li>{@link #JA16SJIS} — Shift_JIS 계열 (레거시). Java 는 벤더확장 superset {@code windows-31j}</li>
 *   <li>{@link #JA16EUC} — EUC-JP 계열 (레거시 UNIX)</li>
 * </ul>
 */
public enum TargetCharset {

    AL32UTF8("AL32UTF8", "UTF-8", "AL32UTF8",
            Set.of("AL32UTF8", "UTF-8", "UTF8", "UTF", "UNICODE")),

    /** Shift_JIS. strict SJIS 는 機種依存文字(髙·﨑)를 오거부하므로 Java 는 superset {@code windows-31j}(MS932). */
    JA16SJIS("JA16SJIS", "windows-31j", "JA16SJIS",
            Set.of("JA16SJIS", "JA16SJISTILDE", "SHIFT_JIS", "SHIFT-JIS", "SJIS",
                    "MS932", "WINDOWS-31J", "CP932", "X-SJIS")),

    JA16EUC("JA16EUC", "EUC-JP", "JA16EUC",
            Set.of("JA16EUC", "JA16EUCTILDE", "EUC-JP", "EUCJP", "EUC_JP", "X-EUC-JP"));

    private final String nlsName;
    private final String javaCharsetName;
    private final String sqlLoaderToken;
    private final Set<String> aliases;

    TargetCharset(String nlsName, String javaCharsetName, String sqlLoaderToken, Set<String> aliases) {
        this.nlsName = nlsName;
        this.javaCharsetName = javaCharsetName;
        this.sqlLoaderToken = sqlLoaderToken;
        this.aliases = aliases;
    }

    /** Oracle NLS_CHARACTERSET 이름 (예: JA16SJIS). */
    public String nlsName() {
        return nlsName;
    }

    /** {@link TargetFileEncoder} 가 바이트 인코딩에 쓰는 Java Charset. */
    public Charset charset() {
        return Charset.forName(javaCharsetName);
    }

    /** SQL*Loader control file 의 {@code CHARACTERSET} 토큰 (Oracle NLS 이름과 동일). */
    public String sqlLoaderToken() {
        return sqlLoaderToken;
    }

    boolean matches(String normalized) {
        return aliases.contains(normalized);
    }
}

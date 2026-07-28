package com.ksinfo.modernize_pro_data.coordinator.load.charset;

import java.io.IOException;
import java.nio.charset.Charset;
import java.nio.charset.CharsetEncoder;
import java.nio.charset.CodingErrorAction;

/**
 * 값이 타깃 문자셋으로 표현 가능한지 <b>사전 검사(fail-fast)</b> — JDBC 적재 경로에서 바인딩 전에 호출.
 *
 * <p>Oracle JDBC 드라이버는 타깃 {@code NLS_CHARACTERSET} 으로 표현 불가한 문자(예: 이모지 → JA16SJIS)를
 * <b>조용히 {@code ?} 로 치환</b>할 수 있다. 금융 이행의 무손실 계약상 이를 허용하지 않으므로, String 값을
 * 바인딩하기 전에 여기서 검사해 불가하면 <b>행/컬럼/코드포인트</b>를 담아 즉시 실패시킨다.
 * (기존 파일 인코더 {@code TargetFileEncoder} 의 {@code CharsetEncoder} REPORT fail-fast 를 값 단위로 추출.)
 */
public final class TargetCharsetValidator {

    private TargetCharsetValidator() {}

    /** 재사용 가능한 REPORT 인코더 (표현 불가 문자에서 오류). load 1회당 하나 만들어 여러 값에 재사용. */
    public static CharsetEncoder reportingEncoder(Charset cs) {
        return cs.newEncoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT);
    }

    /**
     * {@code value} 가 인코더의 charset 으로 표현 가능한지 검사. 불가 시 IOException(행/컬럼/U+코드포인트).
     * null·빈 문자열은 통과. (성능: 정상값은 {@code canEncode} 한 번; 실패 경로에서만 코드포인트 스캔.)
     */
    public static void checkEncodable(CharsetEncoder enc, String value, long rowNum, String colName)
            throws IOException {
        if (value == null || value.isEmpty() || enc.canEncode(value)) return;
        int bad = value.codePoints().filter(cp -> !enc.canEncode(new String(Character.toChars(cp))))
                .findFirst().orElse(0);
        String cs = enc.charset().name();
        throw new IOException(String.format(
                "타깃 문자셋(%s) 인코딩 실패 — row %d, 컬럼 '%s' 의 문자 (U+%04X) 를 %s 로 변환할 수 없습니다. "
                        + "타깃 DB가 저장할 수 없는 문자입니다.",
                cs, rowNum, colName, bad, cs));
    }
}

package com.ksinfo.modernize_pro_data.common.util;

import java.io.BufferedInputStream;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;

/**
 * AS-IS CSV 입력 가드 — 파이프라인 입력 계약(= UTF-8)을 강제해 silent 오적재를 막는다.
 * (2026-07-08 "UTF-8 계약" 라운드. read_csv 의 {@code encoding=} 제거와 짝.)
 *
 * <p>검사 3종:
 * <ul>
 *   <li><b>BOM</b>(EF BB BF): 있으면 report. 안 지우면 첫 컬럼명이 {@code ﻿id} 로 깨져 매핑 실패.
 *       (BOM 자체는 valid UTF-8 = U+FEFF 라 validity 는 통과. strip 은 reader 책임.)</li>
 *   <li><b>NUL</b>(0x00): PG text 는 0x00 저장 불가 ({@code invalid byte sequence for encoding "UTF8": 0x00})
 *       → reject.</li>
 *   <li><b>UTF-8 well-formedness</b>: 외부 변환툴이 깨진 UTF-8 을 뱉을 수 있음. Unicode Table 3-7
 *       (overlong / surrogate / 범위밖 배제) 기준으로 검증 → 위반 시 reject (byte offset 포함).</li>
 * </ul>
 *
 * <p>대용량(GB) 파일을 위해 스트리밍(청크) 처리한다. 순수 로직이라 {@code byte[]} 로 단위테스트 가능.
 */
public final class CsvInputGuard {

    private CsvInputGuard() {}

    /** 검사 결과. ok=true 면 통과(bom 여부만 참고), false 면 reason/offset 에 사유. */
    public record Result(boolean ok, boolean bom, String reason, long offset) {
        static Result pass(boolean bom) { return new Result(true, bom, null, -1); }
        static Result reject(String reason, long offset) { return new Result(false, false, reason, offset); }
    }

    /** byte[] 검사 (테스트/소량 입력). */
    public static Result inspect(byte[] data) {
        try (InputStream in = new ByteArrayInputStream(data)) {
            return inspect(in);
        } catch (IOException e) {
            return Result.reject("read error: " + e.getMessage(), -1);
        }
    }

    /** 파일 스트리밍 검사 (대용량 안전 — 청크 단위). */
    public static Result inspect(Path file) throws IOException {
        try (InputStream in = new BufferedInputStream(Files.newInputStream(file), 1 << 16)) {
            return inspect(in);
        }
    }

    /**
     * 스트림을 1 회 통과하며 BOM/NUL/UTF-8 을 검사. UTF-8 검증은 Unicode Table 3-7 의
     * 바이트 DFA — lead 바이트가 뒤따르는 continuation 개수와 첫 continuation 의 허용 범위를 결정한다.
     */
    public static Result inspect(InputStream in) throws IOException {
        byte[] buf = new byte[1 << 16];
        long pos = 0;
        int[] first3 = { -1, -1, -1 };
        int need = 0;                 // 아직 필요한 continuation 바이트 수
        int nextLo = 0x80, nextHi = 0xBF; // 다음 continuation 바이트의 허용 범위
        int n;
        while ((n = in.read(buf)) > 0) {
            for (int i = 0; i < n; i++) {
                int b = buf[i] & 0xFF;
                if (pos < 3) first3[(int) pos] = b;
                if (b == 0x00) {
                    return Result.reject("NUL byte(0x00) 포함 — PG UTF8 저장 불가", pos);
                }
                if (need == 0) {
                    // lead 바이트
                    if (b <= 0x7F) {
                        // ASCII — ok
                    } else if (b >= 0xC2 && b <= 0xDF) {
                        need = 1; nextLo = 0x80; nextHi = 0xBF;
                    } else if (b == 0xE0) {
                        need = 2; nextLo = 0xA0; nextHi = 0xBF;   // overlong 배제
                    } else if (b >= 0xE1 && b <= 0xEC) {
                        need = 2; nextLo = 0x80; nextHi = 0xBF;
                    } else if (b == 0xED) {
                        need = 2; nextLo = 0x80; nextHi = 0x9F;   // surrogate(U+D800~) 배제
                    } else if (b == 0xEE || b == 0xEF) {
                        need = 2; nextLo = 0x80; nextHi = 0xBF;
                    } else if (b == 0xF0) {
                        need = 3; nextLo = 0x90; nextHi = 0xBF;   // overlong 배제
                    } else if (b >= 0xF1 && b <= 0xF3) {
                        need = 3; nextLo = 0x80; nextHi = 0xBF;
                    } else if (b == 0xF4) {
                        need = 3; nextLo = 0x80; nextHi = 0x8F;   // > U+10FFFF 배제
                    } else {
                        return Result.reject(String.format("invalid UTF-8 lead byte 0x%02X", b), pos);
                    }
                } else {
                    // continuation 바이트
                    if (b < nextLo || b > nextHi) {
                        return Result.reject(String.format("invalid UTF-8 continuation byte 0x%02X", b), pos);
                    }
                    need--;
                    nextLo = 0x80; nextHi = 0xBF;  // 이후 continuation 은 항상 80-BF
                }
                pos++;
            }
        }
        if (need != 0) {
            return Result.reject("truncated UTF-8 sequence at EOF", pos);
        }
        boolean bom = first3[0] == 0xEF && first3[1] == 0xBB && first3[2] == 0xBF;
        return Result.pass(bom);
    }
}

package com.ksinfo.modernize_pro_data.coordinator.worker.source;

import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.io.BufferedOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.ByteBuffer;
import java.nio.CharBuffer;
import java.nio.charset.Charset;
import java.nio.charset.CharsetDecoder;
import java.nio.charset.CoderResult;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * EBCDIC 소스 CSV → UTF-8 변환 SourceReader ({@link EucJpSourceReader} 대칭 구현).
 *
 * <p><b>텍스트 전용</b>. COMP-3 / COMP / zone decimal 같은 <b>바이너리</b> 필드는 범위 밖이며,
 * 기존 계약대로 추출 단계에서 <b>hex 문자열</b>로 풀려 CSV 에 실려 온다는 전제다
 * ({@code apply_scale(VARCHAR raw_hex, INTEGER scale)}). 바이너리가 섞인 레코드를 넣으면
 * 디코더가 오류 없이 쓰레기 텍스트를 만들 수 있다 — 고정길이/카피북 파싱은 외부 툴 영역.
 *
 * <p><b>코드페이지를 반드시 명시해야 한다.</b> EBCDIC 은 변형마다 바이트 배치가 달라서
 * 잘못 고르면 조용히 손상된다 — 실측: {@code x-IBM930} 으로 쓴 파일을 {@code x-IBM939} 로
 * 읽으면 소문자 라틴이 전부 다른 글자가 되는데 <b>예외가 나지 않고</b>, 결과가 정상 UTF-8 이라
 * {@code CsvInputGuard} 도 건수/SUM/체크섬 검증도 전부 통과한다. 그래서 모호한 {@code ebcdic}
 * 은 지원 목록에 넣되 <b>fail-fast</b> 시킨다.
 *
 * <p>변형별 안전망 차이도 있다. 단일 바이트 256 개 중 디코드 오류로 걸리는 개수가
 * {@code x-IBM930} 은 29 개인 반면 <b>{@code IBM037} 은 0 개</b> — 즉 037 에서는
 * {@code REPORT} 가 손상 가드 역할을 전혀 못 한다. 뒤에 남는 것은 {@code CsvInputGuard} 의
 * NUL 검사뿐이고, {@code 0x00} 이 없는 파일은 그대로 통과한다.
 *
 * <p>JEF(후지쯔) / KEIS(히타치) 는 JDK 에 {@link Charset} 이 없어 <b>미지원</b>.
 *
 * <p>개행은 별도 정규화가 필요 없다 — JDK 의 EBCDIC charset 들이 NL {@code 0x15} 와
 * {@code 0x25} 를 모두 {@code U+000A} 로 매핑한다 (EbcdicSourceReaderTest 가 불변식으로 고정).
 * 다만 원본에 {@code 0x0A} 바이트가 없으므로 행 수 카운트는 {@link #sourceLineTerminators()} 를 쓴다.
 *
 * <p>대용량(수 GB) 대응 스트리밍 디코드 — 파일 전체를 메모리에 올리지 않는다.
 */
@Slf4j
@Component
public class EbcdicSourceReader implements SourceReader {

    /** 모호해서 거부할 alias — 코드페이지를 특정할 수 없다. */
    private static final String AMBIGUOUS = "EBCDIC";

    /** alias(대문자) → JDK charset 이름. AMBIGUOUS 는 값이 null 이라 거부 대상. */
    private static final Map<String, String> ALIASES = new LinkedHashMap<>();

    /** EBCDIC 레코드 종단 바이트 — NL(0x15) / LF(0x25). 원본에 ASCII 0x0A 는 없다. */
    private static final byte[] LINE_TERMINATORS = { 0x15, 0x25 };

    private static final int BUF = 1 << 16;   // 64KB

    static {
        ALIASES.put(AMBIGUOUS, null);
        register("x-IBM930", "EBCDIC-IBM930", "IBM930", "CP930", "X-IBM930", "EBCDIC-KANJI", "EBCDIC-KANA");
        register("x-IBM939", "EBCDIC-IBM939", "IBM939", "CP939", "X-IBM939", "EBCDIC-LATIN");
        register("IBM037",   "EBCDIC-IBM037", "IBM037", "CP037", "X-IBM037", "EBCDIC-US");
    }

    /**
     * charset 이 이 JDK 에 있을 때만 alias 를 등록.
     * {@code x-IBM930/939} 는 {@code jdk.charsets} 모듈 소속이라 런타임을 슬림화(jlink)하면
     * 사라질 수 있다. {@code static final} 초기화에서 그대로 던지면 클래스로드 시점에
     * Spring 컨텍스트 전체가 죽으므로 가드한다.
     */
    private static void register(String charsetName, String... aliases) {
        if (!Charset.isSupported(charsetName)) {
            log.warn("EBCDIC charset '{}' 가 이 JDK 에 없어 alias {} 를 등록하지 않음",
                    charsetName, Arrays.toString(aliases));
            return;
        }
        for (String a : aliases) ALIASES.put(a, charsetName);
    }

    @Override
    public boolean supports(String encoding) {
        return encoding != null && ALIASES.containsKey(norm(encoding));
    }

    /** EBCDIC 원본에는 ASCII {@code 0x0A} 가 없다 — 행 수 카운트가 이 바이트들을 세야 한다. */
    @Override
    public byte[] sourceLineTerminators() {
        return LINE_TERMINATORS.clone();
    }

    private static String norm(String encoding) {
        return encoding.trim().toUpperCase();
    }

    /**
     * 선언된 encoding 에 대응하는 charset. 모호한 {@code ebcdic} 이나 미등록 alias 는 fail-fast.
     * 기존 두 reader 와 달리 {@code declaredEncoding} 이 <b>주 입력</b>이다.
     */
    private Charset charsetFor(String declaredEncoding) throws IOException {
        String key = declaredEncoding == null ? "" : norm(declaredEncoding);
        if (AMBIGUOUS.equals(key)) {
            throw new IOException("asisEncoding='" + declaredEncoding + "' 는 코드페이지가 모호합니다 — "
                    + "사이트 설정에서 ebcdic-ibm930 / ebcdic-ibm939 / ebcdic-ibm037 중 하나를 선택하세요. "
                    + "(EBCDIC 은 변형마다 바이트 배치가 달라 잘못 고르면 오류 없이 값이 손상됩니다.)");
        }
        String charsetName = ALIASES.get(key);
        if (charsetName == null) {
            throw new IOException("지원하지 않는 EBCDIC 인코딩: '" + declaredEncoding + "'. "
                    + "지원: ebcdic-ibm930 / ebcdic-ibm939 / ebcdic-ibm037 (JEF·KEIS 미지원)");
        }
        return Charset.forName(charsetName);
    }

    private CharsetDecoder decoderFor(String declaredEncoding) throws IOException {
        return charsetFor(declaredEncoding).newDecoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT);
    }

    @Override
    public Path toUtf8(Path source, String declaredEncoding, Path workDir) throws IOException {
        CharsetDecoder dec = decoderFor(declaredEncoding);   // 파일 만들기 전에 검증 — 모호하면 여기서 끝
        Files.createDirectories(workDir);
        Path out = Files.createTempFile(workDir, "utf8-", ".csv");

        byte[] readBuf = new byte[BUF];
        ByteBuffer bb = ByteBuffer.allocate(BUF + 8);   // +8: 청크 경계 걸친 멀티바이트 carry
        CharBuffer cb = CharBuffer.allocate(BUF + 8);
        long consumed = 0;   // bb 로 넘어오기 전까지 완전 소비된 바이트 수 (에러 offset 기준점)
        boolean ok = false;

        /* dec 는 청크 전체에 걸쳐 재사용해야 한다 — IBM930/939 는 SBCS/DBCS 혼재 charset 이고
           shift-out(0x0E)/shift-in(0x0F) 상태를 CharsetDecoder 인스턴스가 들고 있다.
           청크별로 새 디코더를 만들면 경계를 넘는 shift 상태가 끊겨 조용히 깨진다. */
        try (InputStream in = Files.newInputStream(source);
             OutputStream os = new BufferedOutputStream(Files.newOutputStream(out))) {
            int n;
            while ((n = in.read(readBuf)) != -1) {
                bb.put(readBuf, 0, n);
                bb.flip();
                consumed += drain(dec, bb, cb, os, false, consumed);
                bb.compact();   // 미처리(부분 멀티바이트) 바이트만 남김
            }
            // EOF flush
            bb.flip();
            consumed += drain(dec, bb, cb, os, true, consumed);
            flushChars(dec, cb, os);
            os.flush();
            ok = true;
        } finally {
            if (!ok) Files.deleteIfExists(out);
        }
        return out;
    }

    /** 최대 prefix 크기 상한 (미리보기용 — 8MB 면 수천 행 충분). */
    private static final long PREVIEW_CAP = 8L << 20;

    /**
     * 미리보기/pre-flight — source 앞부분만 디코드 후 UTF-8 임시파일. 파일 끝에서 잘린
     * 부분 멀티바이트(또는 SO/SI 사이 절단)는 무시(경계 아티팩트), 마지막 개행까지만 써서
     * read_csv 가 완전한 행만 보게 한다. prefix 내부의 진짜 invalid 바이트는 fail-fast(byte offset).
     */
    @Override
    public Path toUtf8Preview(Path source, String declaredEncoding, Path workDir, long maxSourceBytes)
            throws IOException {
        CharsetDecoder dec = decoderFor(declaredEncoding);
        Files.createDirectories(workDir);
        int cap = (int) Math.min(maxSourceBytes <= 0 ? PREVIEW_CAP : maxSourceBytes, PREVIEW_CAP);
        byte[] bytes;
        try (InputStream in = Files.newInputStream(source)) {
            bytes = in.readNBytes(cap);
        }
        ByteBuffer bb = ByteBuffer.wrap(bytes);
        CharBuffer cb = CharBuffer.allocate(bytes.length + 4);
        CoderResult cr = dec.decode(bb, cb, false);   // endOfInput=false → 끝의 부분 멀티바이트는 underflow(무시)
        if (cr.isError()) {
            throw new IOException("EBCDIC 미리보기 디코드 실패 — invalid 바이트 (byte offset "
                    + bb.position() + ")");
        }
        cb.flip();
        String s = cb.toString();
        int nl = s.lastIndexOf('\n');   // charset 이 0x15/0x25 를 이미 LF 로 매핑한다
        if (nl >= 0) s = s.substring(0, nl + 1);       // 완전한 행까지만
        Path out = Files.createTempFile(workDir, "utf8-prev-", ".csv");
        Files.writeString(out, s, StandardCharsets.UTF_8);
        return out;
    }

    /**
     * bb 를 가능한 만큼 디코드해 os(UTF-8)로 write. 완전 소비한 바이트 수 반환.
     * malformed/unmappable 이면 IOException (byte offset = base + bb.position()).
     */
    private long drain(CharsetDecoder dec, ByteBuffer bb, CharBuffer cb, OutputStream os,
                       boolean eof, long base) throws IOException {
        int startPos = bb.position();
        while (true) {
            CoderResult cr = dec.decode(bb, cb, eof);
            if (cr.isOverflow()) {           // cb 가득 참 → flush 후 계속
                writeChars(cb, os);
                continue;
            }
            if (cr.isError()) {
                long offset = base + bb.position();   // 실패 출력파일 삭제는 toUtf8 finally 가 처리
                throw new IOException("EBCDIC 디코드 실패 — invalid/변환불가 바이트 "
                        + "(byte offset " + offset + ", " + cr.length() + " byte). 입력 인코딩을 확인하세요.");
            }
            // underflow — 이 청크는 다 봤고, 부분 멀티바이트만 남을 수 있음
            writeChars(cb, os);
            break;
        }
        return (long) bb.position() - startPos;
    }

    private void flushChars(CharsetDecoder dec, CharBuffer cb, OutputStream os) throws IOException {
        CoderResult cr = dec.flush(cb);
        writeChars(cb, os);
        if (cr.isError()) {
            throw new IOException("EBCDIC 디코드 flush 실패 — 파일 끝에 불완전한 멀티바이트");
        }
    }

    private void writeChars(CharBuffer cb, OutputStream os) throws IOException {
        cb.flip();
        if (cb.hasRemaining()) {
            os.write(cb.toString().getBytes(StandardCharsets.UTF_8));
        }
        cb.clear();
    }
}

package com.ksinfo.modernize_pro_data.coordinator.worker.source;

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
import java.util.Set;

/**
 * EUC-JP 소스 CSV → UTF-8 변환 SourceReader (계획서 §6 / {@link ShiftJisSourceReader} 대칭 구현).
 *
 * <p>레거시 UNIX 계열 일본 금융 시스템의 EUC-JP 추출 CSV 대응. invalid / 변환불가 바이트는
 * {@code REPORT} 로 잡아 **fail-fast (byte offset 포함)** — 조용한 손상 방지.
 *
 * <p>대용량(수 GB) 대응 스트리밍 디코드 — 파일 전체를 메모리에 올리지 않는다.
 */
@Component
public class EucJpSourceReader implements SourceReader {

    private static final Set<String> ENCODINGS = Set.of(
            "EUC-JP", "EUCJP", "EUC_JP", "X-EUC-JP", "JA16EUC");

    private static final Charset EUC_JP = Charset.forName("EUC-JP");

    private static final int BUF = 1 << 16;   // 64KB

    @Override
    public boolean supports(String encoding) {
        return encoding != null && ENCODINGS.contains(encoding.trim().toUpperCase());
    }

    @Override
    public Path toUtf8(Path source, String declaredEncoding, Path workDir) throws IOException {
        Files.createDirectories(workDir);
        Path out = Files.createTempFile(workDir, "utf8-", ".csv");
        CharsetDecoder dec = EUC_JP.newDecoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT);

        byte[] readBuf = new byte[BUF];
        ByteBuffer bb = ByteBuffer.allocate(BUF + 8);   // +8: 청크 경계 걸친 멀티바이트 carry
        CharBuffer cb = CharBuffer.allocate(BUF + 8);
        long consumed = 0;   // bb 로 넘어오기 전까지 완전 소비된 바이트 수 (에러 offset 기준점)
        boolean ok = false;

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
        } catch (IOException e) {
            throw e;
        } finally {
            if (!ok) Files.deleteIfExists(out);
        }
        return out;
    }

    /** 최대 prefix 크기 상한 (미리보기용 — 8MB 면 수천 행 충분). */
    private static final long PREVIEW_CAP = 8L << 20;

    /**
     * 미리보기/pre-flight — source 앞부분만 EUC-JP 디코드 후 UTF-8 임시파일. 파일 끝에서 잘린
     * 부분 멀티바이트는 무시(경계 아티팩트), 마지막 개행까지만 써서 read_csv 가 완전한 행만 보게 한다.
     * prefix 내부의 진짜 invalid 바이트는 fail-fast(byte offset).
     */
    @Override
    public Path toUtf8Preview(Path source, String declaredEncoding, Path workDir, long maxSourceBytes)
            throws IOException {
        Files.createDirectories(workDir);
        int cap = (int) Math.min(maxSourceBytes <= 0 ? PREVIEW_CAP : maxSourceBytes, PREVIEW_CAP);
        byte[] bytes;
        try (InputStream in = Files.newInputStream(source)) {
            bytes = in.readNBytes(cap);
        }
        CharsetDecoder dec = EUC_JP.newDecoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT);
        ByteBuffer bb = ByteBuffer.wrap(bytes);
        CharBuffer cb = CharBuffer.allocate(bytes.length + 4);
        CoderResult cr = dec.decode(bb, cb, false);   // endOfInput=false → 끝의 부분 멀티바이트는 underflow(무시)
        if (cr.isError()) {
            throw new IOException("EUC-JP 미리보기 디코드 실패 — invalid 바이트 (byte offset "
                    + bb.position() + ")");
        }
        cb.flip();
        String s = cb.toString();
        int nl = s.lastIndexOf('\n');
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
                throw new IOException("EUC-JP 디코드 실패 — invalid/변환불가 바이트 "
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
            throw new IOException("EUC-JP 디코드 flush 실패 — 파일 끝에 불완전한 멀티바이트");
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

package com.ksinfo.modernize_pro_data.coordinator.worker.source;

import java.io.IOException;
import java.nio.file.Path;

/**
 * AS-IS 소스 CSV 를 파이프라인 입력 계약(UTF-8)으로 맞추는 SPI (계획서 A4 변환 seam).
 *
 * <p>파이프라인 자체는 "입력은 UTF-8" 을 전제로 동작하고, 비-UTF-8(Shift_JIS 등) → UTF-8 변환은
 * 이 SPI 구현체 안에서 처리한다. 기본 구현({@code Utf8PassthroughSourceReader})은 no-op(원본 그대로).
 * 나중에 EBCDIC 등 다른 인코딩이 필요하면 구현체를 하나 추가하면 되고, 파이프라인은 불변.
 */
public interface SourceReader {

    /** 이 reader 가 {@code encoding}(site.asisEncoding) 을 처리하는가. */
    boolean supports(String encoding);

    /**
     * {@code source} CSV 를 UTF-8 로 보장된 파일 경로로 반환.
     * 이미 UTF-8 이면 원본 경로 그대로, 아니면 {@code workDir} 에 UTF-8 임시 파일을 만들어 반환.
     *
     * @param source          원본 CSV 파일
     * @param declaredEncoding site.asisEncoding (null/blank = UTF-8 로 간주)
     * @param workDir         임시 UTF-8 파일을 만들 디렉터리 (run 스크래치)
     * @throws IOException 디코드 실패(invalid/변환불가 바이트) — fail-fast, byte offset 포함
     */
    Path toUtf8(Path source, String declaredEncoding, Path workDir) throws IOException;

    /**
     * 미리보기/pre-flight 용 — source 앞부분 {@code maxSourceBytes} 까지만 UTF-8 로 변환.
     * 대용량(수 GB) 파일을 미리보기 때마다 통째로 변환하지 않도록 하는 bounded 변형.
     * 기본 구현은 전체 변환에 위임(passthrough 는 원본이라 무관); 디코딩 reader 는 override 해서 prefix 만.
     */
    default Path toUtf8Preview(Path source, String declaredEncoding, Path workDir, long maxSourceBytes)
            throws IOException {
        return toUtf8(source, declaredEncoding, workDir);
    }
}


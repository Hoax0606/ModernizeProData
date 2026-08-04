package com.ksinfo.modernize_pro_data.coordinator.worker.source;

import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.nio.file.Path;
import java.util.List;

/**
 * SourceReader SPI 레지스트리 — site.asisEncoding 에 맞는 reader 를 골라 소스 CSV 를 UTF-8 로.
 * (StageRunner 와 동일한 List 주입 패턴.)
 */
@Component
@Slf4j
public class SourceReaderRegistry {

    private final List<SourceReader> readers;

    public SourceReaderRegistry(List<SourceReader> readers) {
        this.readers = readers;
        log.info("SourceReaderRegistry initialized with {} reader(s): {}",
                readers.size(), readers.stream().map(r -> r.getClass().getSimpleName()).toList());
    }

    /**
     * encoding 을 지원하는 첫 reader 로 UTF-8 변환. 지원 reader 가 없으면 원본 그대로 반환
     * (passthrough — 이후 CsvInputGuard 가 비-UTF-8 을 reject).
     */
    public Path toUtf8(Path source, String encoding, Path workDir) throws IOException {
        for (SourceReader r : readers) {
            if (r.supports(encoding)) {
                return r.toUtf8(source, encoding, workDir);
            }
        }
        log.warn("No SourceReader for encoding='{}' — passthrough (CsvInputGuard 가 검증)", encoding);
        return source;
    }

    /**
     * 미리보기/pre-flight 용 bounded 변환 — source 앞부분 {@code maxSourceBytes} 까지만 UTF-8 로.
     * 대용량 파일을 미리보기 때마다 통째 변환하지 않도록. 지원 reader 없으면 원본 그대로.
     */
    public Path toUtf8Preview(Path source, String encoding, Path workDir, long maxSourceBytes) throws IOException {
        for (SourceReader r : readers) {
            if (r.supports(encoding)) {
                return r.toUtf8Preview(source, encoding, workDir, maxSourceBytes);
            }
        }
        return source;
    }
}

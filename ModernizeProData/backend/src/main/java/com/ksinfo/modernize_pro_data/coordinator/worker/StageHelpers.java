package com.ksinfo.modernize_pro_data.coordinator.worker;

import com.ksinfo.modernize_pro_data.coordinator.runlog.RunLogLine;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.OffsetDateTime;
import java.util.stream.Stream;

/**
 * Stage runner 공통 유틸 (static methods).
 *   - CSV 파일 해석 (SiteCsvPreviewController 패턴 그대로 — case-insensitive fallback)
 *   - RunLogLine 빌더 헬퍼
 */
public final class StageHelpers {

    private StageHelpers() {}

    /**
     * Resolve {baseDir}/{tableName}.csv. 대소문자 fallback. 없으면 null.
     */
    public static Path resolveCsvFile(Path baseDir, String tableName) {
        if (baseDir == null || !Files.isDirectory(baseDir)) return null;
        Path exact = baseDir.resolve(tableName + ".csv").normalize();
        if (!exact.startsWith(baseDir)) return null;
        if (Files.isRegularFile(exact)) return exact;

        String want = (tableName + ".csv").toLowerCase();
        try (Stream<Path> stream = Files.list(baseDir)) {
            return stream
                    .filter(Files::isRegularFile)
                    .filter(p -> p.getFileName().toString().toLowerCase().equals(want))
                    .findFirst()
                    .orElse(null);
        } catch (IOException e) {
            return null;
        }
    }

    public static RunLogLine line(long seq, String runId, String stage, short level, String message) {
        return RunLogLine.builder()
                .seq(seq)
                .runId(runId)
                .ts(OffsetDateTime.now())
                .level(level)
                .stage(stage)
                .message(message)
                .build();
    }

    public static RunLogLine info(long seq, String runId, String stage, String message) {
        return line(seq, runId, stage, RunLogLine.LEVEL_INFO, message);
    }

    public static RunLogLine warn(long seq, String runId, String stage, String message) {
        return line(seq, runId, stage, RunLogLine.LEVEL_WARN, message);
    }

    public static RunLogLine error(long seq, String runId, String stage, String message) {
        return line(seq, runId, stage, RunLogLine.LEVEL_ERROR, message);
    }
}

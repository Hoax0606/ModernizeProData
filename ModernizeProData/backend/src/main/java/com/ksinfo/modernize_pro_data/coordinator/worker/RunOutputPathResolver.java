package com.ksinfo.modernize_pro_data.coordinator.worker;

import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.time.OffsetDateTime;
import java.time.format.DateTimeFormatter;

/**
 * Run output 디렉토리 결정 + 생성.
 *
 * 구조: {basePath}/{projectId}/{runIndex}-{yyyyMMddHHmmss}/{parquet1|parquet2|quarantine}/
 * Sprint 0 결정 5.
 */
@Service
@Slf4j
public class RunOutputPathResolver {

    private static final DateTimeFormatter TS_FMT = DateTimeFormatter.ofPattern("yyyyMMddHHmmss");

    /** Default = ${user.home}/.modernize/output. application.yml 의 modernize.output.base-path 로 override. */
    @Value("${modernize.output.base-path:#{systemProperties['user.home']}/.modernize/output}")
    private String basePath;

    public Path resolveAndCreate(String projectId, long runIndex, OffsetDateTime startedAt) {
        String ts = startedAt.format(TS_FMT);
        Path runDir = Paths.get(basePath, projectId, runIndex + "-" + ts);
        try {
            Files.createDirectories(runDir.resolve("parquet1"));
            Files.createDirectories(runDir.resolve("parquet2"));
            Files.createDirectories(runDir.resolve("quarantine"));
        } catch (IOException e) {
            throw new RuntimeException("Failed to create output dirs at " + runDir, e);
        }
        log.info("Run output dir created: {}", runDir);
        return runDir;
    }
}

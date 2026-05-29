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
 * 구조: {basePath}/{projectFolder}/{runIndex}-{yyyyMMddHHmmss}/{parquet1|parquet2|quarantine}/
 *
 * projectFolder 규칙 (2026-05-29 부터, "hybrid" 모델):
 *   - projectName 있고 sanitize 후 비어있지 않으면 → "{safeName}__{projectId}"
 *   - 그 외 → "{projectId}"
 *
 * 왜 hybrid 인가:
 *   - projectId 만이면 file explorer 에서 어느 프로젝트인지 알 수 없음 (p-7d0ca108 식 hex).
 *   - projectName 만이면 rename 시 폴더 경로 미아 + 특수문자/공백 호환성 + 중복 가능.
 *   - "이름__ID" 조합: 가독성 (이름) + 안정성 (ID 키) 둘 다.
 *
 * 호환성: 기존 run (이전 projectId 만 폴더) 은 그대로 둠. 새 run 만 hybrid 형식.
 * Sprint 0 결정 5 의 후속 (2026-05-29).
 */
@Service
@Slf4j
public class RunOutputPathResolver {

    private static final DateTimeFormatter TS_FMT = DateTimeFormatter.ofPattern("yyyyMMddHHmmss");

    /** sanitize 결과 길이 상한 — Windows 256 path 한계 + run 디렉터리 + parquet 파일명 여유. */
    private static final int NAME_LIMIT = 50;

    /**
     * Default = C:/modernize/output (Windows 기준 — 도구가 jpackage 로 Windows 데스크탑 배포).
     * 2026-05-29 부터 user.home 에서 C 드라이브 루트로 이동 — file explorer 접근 단순화 + 운영자
     * 데이터 위치 명확. Linux/Mac 개발 환경은 application-local.yml 로 override 권장:
     *   modernize.output.base-path: /var/lib/modernize/output  (혹은 적절한 dev 경로)
     */
    @Value("${modernize.output.base-path:C:/modernize/output}")
    private String basePath;

    /**
     * 새 시그니처 — projectName 도 받음. {@link #sanitize(String)} 로 안전하게 처리 후
     * "name__id" 형식 폴더 생성.
     */
    public Path resolveAndCreate(String projectId, String projectName, long runIndex, OffsetDateTime startedAt) {
        String safeName = sanitize(projectName);
        String folder = safeName.isEmpty() ? projectId : safeName + "__" + projectId;
        return createDirsAndReturn(folder, runIndex, startedAt);
    }

    /**
     * Backward-compat — projectId 만 받는 옛 시그니처. 새 코드는 위 3-arg 사용 권장.
     * 호출처 다 정리되면 제거 가능.
     */
    @Deprecated
    public Path resolveAndCreate(String projectId, long runIndex, OffsetDateTime startedAt) {
        return createDirsAndReturn(projectId, runIndex, startedAt);
    }

    private Path createDirsAndReturn(String folder, long runIndex, OffsetDateTime startedAt) {
        String ts = startedAt.format(TS_FMT);
        Path runDir = Paths.get(basePath, folder, runIndex + "-" + ts);
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

    /**
     * 프로젝트 이름 → 파일시스템 안전 식별자 변환.
     *   - 영문/숫자/한글/언더바 외 문자 → '_' 치환.
     *   - 연속 '_' → 단일 '_'.
     *   - 앞뒤 '_' 제거.
     *   - 길이 NAME_LIMIT 초과 시 truncate.
     *   - null / 빈 문자열 / sanitize 후 빈 문자열 → 빈 문자열 반환 (호출부가 ID 단독으로 fallback).
     *
     * Windows reserved name (CON, AUX, ...) 충돌 가능성 있으나 ID suffix 가 붙어 unique 보장.
     */
    static String sanitize(String name) {
        if (name == null) return "";
        String t = name.replaceAll("[^a-zA-Z0-9가-힣_]+", "_")
                       .replaceAll("_+", "_")
                       .replaceAll("^_|_$", "");
        if (t.length() > NAME_LIMIT) t = t.substring(0, NAME_LIMIT).replaceAll("_+$", "");
        return t;
    }
}

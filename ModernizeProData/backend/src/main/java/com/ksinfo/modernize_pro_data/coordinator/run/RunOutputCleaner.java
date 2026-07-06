package com.ksinfo.modernize_pro_data.coordinator.run;

import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Comparator;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.stream.Stream;

/**
 * Run output 디렉터리 정리 — worker 디스크 무한 누적 방지.
 *
 * <p>배경 (2026-06-08 진단): run 마다 {@code {base}/{project}/{runIndex}-{ts}/} 아래
 * parquet1/parquet2/temp/duck-tmp 를 쓰는데 종료 후 아무도 안 지웠다. file-mode 에서도 run 마다
 * 독립 in-memory DuckDB 인스턴스를 쓰고 memory_limit 초과분을 duck-tmp 로 spill 하므로, 누적된
 * 폴더 + spill 이 디스크를 채워 후속 run 의 extract/transform/load 가 점점 느려졌다 (같은 데이터
 * 2회차가 2~4배 느림). 이 서비스가 두 단계로 정리한다:
 *
 * <ol>
 *   <li><b>scratch 즉시 삭제</b> — run 종료 직후 {@code duck-tmp}(spill) + {@code temp}(임시 CSV).
 *       resume/stage-cache 가 읽지 않는 순수 임시물이라 항상 안전.</li>
 *   <li><b>retention 스윕</b> — 프로젝트별 run 폴더를 최근 {@code retention} 개만 남기고 삭제.
 *       resume(직전 실패 run) / stage-cache(직전 성공 run) 가 parquet 을 읽으므로 최근 것은 보존.
 *       진행 중(pending/running) run 의 폴더는 절대 삭제 안 함(protect).</li>
 * </ol>
 */
@Service
@Slf4j
public class RunOutputCleaner {

    /** scratch(duck-tmp/temp) 즉시 삭제 on/off. */
    @Value("${modernize.run.output.clean-scratch:true}")
    private boolean cleanScratchEnabled;

    /** 프로젝트별 보존할 최근 run 폴더 수. 0 이하 = retention 비활성. */
    @Value("${modernize.run.output.retention:3}")
    private int retention;

    /** run 종료 직후 scratch(duck-tmp spill + temp CSV) 삭제. resume/cache 무관 — 항상 안전. */
    public void cleanScratch(Path runDir) {
        if (!cleanScratchEnabled || runDir == null) return;
        deleteQuietly(runDir.resolve("duck-tmp"));
        deleteQuietly(runDir.resolve("temp"));
    }

    /**
     * runDir 의 부모(프로젝트 폴더) 안에서 최근 {@code retention} 개 run 폴더만 남기고 삭제.
     * {@code protect} 에 든 경로(진행 중 run 등)는 retention 카운트와 무관하게 보존.
     */
    public void applyRetention(Path runDir, Set<Path> protect) {
        if (retention <= 0 || runDir == null) return;
        Path projectDir = runDir.getParent();
        if (projectDir == null || !Files.isDirectory(projectDir)) return;

        List<Path> dirs;
        try (Stream<Path> s = Files.list(projectDir)) {
            dirs = s.filter(Files::isDirectory)
                    .sorted(Comparator.comparingLong(RunOutputCleaner::mtime).reversed())
                    .toList();
        } catch (IOException e) {
            log.warn("retention: list failed {}: {}", projectDir, e.getMessage());
            return;
        }

        Set<Path> keep = new HashSet<>();
        if (protect != null) {
            for (Path p : protect) if (p != null) keep.add(norm(p));
        }
        int kept = 0;
        for (Path d : dirs) {
            if (keep.contains(norm(d))) continue;   // 진행 중 run — 보존
            if (kept < retention) { kept++; continue; }   // 최근 N — 보존
            deleteQuietly(d);
            log.info("retention: deleted old run output {}", d);
        }
    }

    private static Path norm(Path p) {
        return p.toAbsolutePath().normalize();
    }

    private static long mtime(Path p) {
        try {
            return Files.getLastModifiedTime(p).toMillis();
        } catch (IOException e) {
            return 0L;
        }
    }

    /** 재귀 삭제 — 실패해도 throw 안 함(정리는 best-effort, run 결과에 영향 없게). */
    private void deleteQuietly(Path p) {
        if (p == null || !Files.exists(p)) return;
        try (Stream<Path> walk = Files.walk(p)) {
            walk.sorted(Comparator.reverseOrder()).forEach(x -> {
                try {
                    Files.deleteIfExists(x);
                } catch (IOException ignore) {
                    /* 파일 락(다른 thread) 등 — best-effort */
                }
            });
        } catch (IOException e) {
            log.warn("delete failed {}: {}", p, e.getMessage());
        }
    }
}

package com.ksinfo.modernize_pro_data.coordinator.run;

import com.ksinfo.modernize_pro_data.common.duckdb.DuckDbService;
import com.ksinfo.modernize_pro_data.coordinator.mapping.MappingTableBinding;
import com.ksinfo.modernize_pro_data.coordinator.mapping.MappingTableBindingRepository;
import com.ksinfo.modernize_pro_data.coordinator.run.stage.StageInstance;
import com.ksinfo.modernize_pro_data.coordinator.run.stage.StageInstanceRepository;
import com.ksinfo.modernize_pro_data.coordinator.run.stage.StageStatus;
import com.ksinfo.modernize_pro_data.coordinator.runlog.RunLogIngestService;
import com.ksinfo.modernize_pro_data.coordinator.site.Project;
import com.ksinfo.modernize_pro_data.coordinator.site.ProjectRepository;
import com.ksinfo.modernize_pro_data.coordinator.site.Site;
import com.ksinfo.modernize_pro_data.coordinator.site.SiteRepository;
import com.ksinfo.modernize_pro_data.coordinator.worker.RunOutputPathResolver;
import com.ksinfo.modernize_pro_data.coordinator.worker.StageContext;
import com.ksinfo.modernize_pro_data.coordinator.worker.WorkerExecutor;
import com.ksinfo.modernize_pro_data.coordinator.dispatch.WorkerDispatcher;
import com.ksinfo.modernize_pro_data.coordinator.worker.WorkerNodeService;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.scheduling.annotation.Async;
import org.springframework.stereotype.Component;
import org.springframework.transaction.event.TransactionPhase;
import org.springframework.transaction.event.TransactionalEventListener;

import java.nio.file.Path;
import java.time.OffsetDateTime;
import java.util.HashSet;
import java.util.List;
import java.util.Optional;
import java.util.Set;
import java.util.stream.Collectors;

/**
 * RunService.startRun 의 transaction commit 직후, 별 thread 에서 stage 실행을 trigger.
 *
 * 흐름:
 *   1. RunHistory / Project / Site / bindings / stages load
 *   2. runIndex = 그 project 의 누적 run 수 (이 run 까지 포함)
 *   3. output dir 생성 + StageContext build
 *   4. RunLog open → WorkerExecutor.execute → completeRun (성공) / failRun (예외)
 *   5. RunLog close
 *
 * @EnableAsync 가 main class 에 있어 별 thread 에서 동작.
 * SimpleAsyncTaskExecutor (default) — thread per task. PoC OK, 추후 ThreadPoolTaskExecutor 로 제한.
 */
@Component
@RequiredArgsConstructor
@Slf4j
public class RunExecutionListener {

    private final RunHistoryRepository runRepo;
    private final ProjectRepository projectRepo;
    private final SiteRepository siteRepo;
    private final MappingTableBindingRepository bindingRepo;
    private final StageInstanceRepository stageRepo;
    private final WorkerExecutor workerExecutor;
    private final RunLogIngestService runLogIngest;
    private final RunOutputPathResolver outputResolver;
    private final RunService runService;
    private final DuckDbService duckDbService;
    private final com.ksinfo.modernize_pro_data.common.config.RunCapacityPlanner capacityPlanner;
    private final RunControlRegistry runControlRegistry;
    private final RunStageCacheService stageCacheService;
    private final WorkerNodeService workerNodeService;
    private final WorkerDispatcher workerDispatcher;
    private final RunOutputCleaner outputCleaner;

    @Value("${modernize.mode:coordinator}")
    private String mode;

    @Value("${modernize.coordinator.self-username:master}")
    private String coordinatorSelfUsername;

    @TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
    @Async
    public void onRunStarted(RunStartedEvent event) {
        String runId = event.runId();
        String projectId = event.projectId();
        // Coordinator mode 에서 assignee 의 Worker 가 online 이고 assignee 가 Coordinator self
        // 가 아니면 그 Worker 가 STOMP 으로 RUN_START 를 받아 자기 PC 에서 실행 → Coordinator
        // 의 local executor 는 skip.
        // Coordinator self user 가 assignee 면 worker_node 가 없을 테니 항상 local 실행.
        // Worker mode 에선 이 listener 자체가 안 발사된다 (RunService.start 가 Coordinator 에서만 호출).
        if ("coordinator".equals(mode)) {
            RunHistory rh = runRepo.findById(runId).orElse(null);
            String assignee = rh == null ? null : rh.getWorkerId();
            boolean isSelf = assignee != null && assignee.equals(coordinatorSelfUsername);
            if (rh != null && assignee != null && !isSelf
                    && workerNodeService.findOnlineForUsername(assignee).isPresent()) {
                // Worker daemon 이 등록·online 상태 → 그 worker 로 WS push.
                // 이 시점은 startRun transaction 의 AFTER_COMMIT 이라 run_history 가 이미 DB
                // 에 박혀있다 — Worker 가 받자마자 runRepo.findById(runId) 해도 안전하다.
                log.info("Run delegated to worker {} (skipping local execution) runId={}", assignee, runId);
                try {
                    workerDispatcher.dispatchRunStart(rh);
                } catch (Exception e) {
                    log.error("WS dispatch failed runId={} — fallback to Coordinator local execution",
                            runId, e);
                    executeRun(runId);
                }
                return;
            }
        }
        executeRun(runId);
    }

    /**
     * 한 run 의 stage 파이프라인을 이 PC 의 backend (Coordinator local 또는 Worker daemon) 에서
     * 실제로 돌린다. RunService 가 발사하는 RunStartedEvent 의 흐름과, Worker daemon 의
     * STOMP RUN_START 수신 흐름 둘 다 진입점.
     */
    public void executeRun(String runId) {
        RunHistory rhHead = runRepo.findById(runId).orElse(null);
        String projectId = rhHead == null ? null : rhHead.getProjectId();
        log.info("Run execution thread started runId={} projectId={}", runId, projectId);

        StageContext ctx;
        try {
            RunHistory rh = runRepo.findById(runId)
                    .orElseThrow(() -> new IllegalStateException("run not found: " + runId));
            Project project = projectRepo.findById(projectId)
                    .orElseThrow(() -> new IllegalStateException("project not found: " + projectId));
            Site site = siteRepo.findById(project.getSiteId())
                    .orElseThrow(() -> new IllegalStateException("site not found: " + project.getSiteId()));
            List<MappingTableBinding> bindings = bindingRepo.findByProjectId(projectId);
            // 부분 실행 — metadata.selectedTables 있으면 그 TO-BE 테이블만 처리 (없으면 전체).
            Object sel = rh.getMetadata() == null ? null : rh.getMetadata().get("selectedTables");
            if (sel instanceof List<?> selList && !selList.isEmpty()) {
                Set<String> selSet = selList.stream().map(String::valueOf).collect(Collectors.toSet());
                bindings = bindings.stream()
                        .filter(b -> selSet.contains(b.getTobeTable()))
                        .toList();
            }
            List<StageInstance> stages = stageRepo.findByRunIdOrderBySeqAsc(runId);

            long runIndex = runRepo.countByProjectId(projectId);   // 이 run 까지 포함 = 1..N
            // hybrid 폴더명 (2026-05-29 부터) — '{sanitizedName}__{projectId}'. file explorer 가독성.
            Path outputDir = outputResolver.resolveAndCreate(projectId, project.getName(), runIndex, rh.getStartedAt());
            String duckdbSchema = "run_" + runId.replace("-", "_");

            /* Resume-from-failed-run 추적용 — 후속 retry 가 옛 parquet 위치를 찾을 수 있게 박제.
               별도 transaction (현재 메서드는 transaction 밖). */
            runService.recordOutputDir(runId, outputDir.toString());

            ctx = StageContext.builder()
                    .runHistory(rh)
                    .project(project)
                    .site(site)
                    .bindings(bindings)
                    .stages(stages)
                    .outputDir(outputDir)
                    .duckdbSchema(duckdbSchema)
                    .runControlRegistry(runControlRegistry)
                    .build();
        } catch (Exception e) {
            log.error("Run setup failed runId={}", runId, e);
            safeFail(runId, "setup failed: " + e.getMessage());
            return;
        }

        runLogIngest.openRun(runId, projectId);
        runControlRegistry.register(runId);   // pause/resume/cancel 제어 등록
        // 이 run 전용 격리 DuckDB connection 을 실행 thread 에 바인딩 — 동시 run 간 공유 connection
        // "pending query result" 충돌 회피 + run별 memory_limit 격리(독립 인스턴스). finally 에서 unbind(close).
        // run별 temp_directory 로 spill 충돌도 방지.
        String runDuckTemp = ctx.getOutputDir().resolve("duck-tmp").toString();
        duckDbService.bindRunConnection(capacityPlanner.getRunMemoryLimit(), runDuckTemp);
        // LoadStage 병렬 Future thread 는 ThreadLocal 을 못 보므로 run connection 을 ctx 로 전달.
        ctx.setDuckConnection(duckDbService.currentRunConnection());
        try {
            // 이전/크래시 run 의 DuckDB 작업 schema 정리 (실행 중 run = pending/running 은 보존).
            Set<String> activeSchemas = runRepo
                    .findByStatusIn(List.of(RunStatus.pending, RunStatus.running)).stream()
                    .map(r -> "run_" + r.getId().replace("-", "_"))
                    .collect(Collectors.toSet());
            duckDbService.sweepRunSchemas(activeSchemas);

            // stage-cache (재실행 캐시) — opt-in & non-cutover 일 때 직전 CP2(parquet2) 재사용 시도.
            boolean cutover = ctx.getRunHistory().getRunType() == RunType.cutover;
            boolean useCache = ctx.getRunHistory().getMetadata() != null
                    && Boolean.TRUE.equals(ctx.getRunHistory().getMetadata().get("useCache"));
            String fingerprint = null;
            Path effectiveParquet2Dir = ctx.parquet2Dir();
            if (useCache && !cutover) {
                fingerprint = stageCacheService.computeFingerprint(ctx);
                Optional<Path> hit = stageCacheService.findUsableCache(ctx, fingerprint);
                if (hit.isPresent()) {
                    stageCacheService.loadCacheIntoDuckDb(ctx, hit.get());
                    markCachedStagesDone(ctx);
                    effectiveParquet2Dir = hit.get();
                    log.info("stage-cache HIT runId={} dir={} — extract/reconcile/transform skipped",
                            runId, hit.get());
                }
            }

            /* Resume-from-failed-run — RunService.startRun 이 이미 옛 run 의 stage 들을 미리 success
               마킹했지만, 실제 데이터(DuckDB asis_/tobe_ 테이블) 는 아직 비어있다. 옛 run 의 디스크
               parquet 을 새 schema 에 복원해서 후속 stage(예: Audit) 가 데이터 위에서 동작하게 한다.
               검증 실패 (옛 outputDir 부재 / parquet 부재) 시 그냥 진행 — pre-mark 된 stage 가 skip
               되지만 후속 stage 에서 'asis_xxx 테이블 없음' 같은 명확한 에러로 빠질 것. */
            String resumeFromRunId = ctx.getRunHistory().getMetadata() == null ? null
                    : (String) ctx.getRunHistory().getMetadata().get("resumeFromRunId");
            if (resumeFromRunId != null) {
                restoreParquetFromOldRun(ctx, resumeFromRunId);
            }

            workerExecutor.execute(ctx);
            runService.completeRun(runId, null, null);

            // 성공 → 다음 run 재사용용 fingerprint + parquet2Dir 기록 (non-cutover).
            if (!cutover) {
                if (fingerprint == null) fingerprint = stageCacheService.computeFingerprint(ctx);
                runService.recordCacheMeta(runId, fingerprint, effectiveParquet2Dir.toString());
            }
        } catch (Exception e) {
            log.error("Run execution failed runId={}", runId, e);
            safeFail(runId, e.getMessage());
        } finally {
            runControlRegistry.remove(runId);
            duckDbService.unbindRunConnection();   // run-scoped DuckDB connection close (@Async thread 재사용 누수 방지)
            try {
                runLogIngest.closeRun(runId);
            } catch (Exception e) {
                log.warn("Failed to close RunLog runId={}", runId, e);
            }
            // worker 디스크 누적 방지 — scratch(duck-tmp/temp) 즉시 삭제 + 프로젝트별 최근 N개만 보존.
            // (진행 중 run 의 outputDir 은 protect 로 절대 삭제 안 함.)
            try {
                if (ctx != null && ctx.getOutputDir() != null) {
                    outputCleaner.cleanScratch(ctx.getOutputDir());
                    outputCleaner.applyRetention(ctx.getOutputDir(), activeRunOutputDirs());
                }
            } catch (Exception e) {
                log.warn("output cleanup failed runId={}: {}", runId, e.getMessage());
            }
        }
        log.info("Run execution thread finished runId={}", runId);
    }

    private void safeFail(String runId, String message) {
        try {
            runService.failRun(runId, null, null, message);
        } catch (Exception e) {
            log.error("Failed to mark run as failed runId={}", runId, e);
        }
    }

    /** retention 삭제에서 제외할 경로 — 진행 중(pending/running) run 의 outputDir (metadata 박제값). */
    private Set<Path> activeRunOutputDirs() {
        Set<Path> dirs = new HashSet<>();
        try {
            for (RunHistory r : runRepo.findByStatusIn(List.of(RunStatus.pending, RunStatus.running))) {
                Object od = r.getMetadata() == null ? null : r.getMetadata().get("outputDir");
                if (od instanceof String s && !s.isBlank()) {
                    dirs.add(Path.of(s));
                }
            }
        } catch (Exception e) {
            log.warn("activeRunOutputDirs lookup failed: {}", e.getMessage());
        }
        return dirs;
    }

    /** stage-cache HIT 시 extract/reconcile/transform StageInstance 를 success(skipped) 마킹 → executor 가 skip. */
    private void markCachedStagesDone(StageContext ctx) {
        Set<String> cached = Set.of("extract", "reconcile", "transform");
        OffsetDateTime now = OffsetDateTime.now();
        for (StageInstance si : ctx.getStages()) {
            if (cached.contains(si.getStageKey())) {
                si.setStatus(StageStatus.success);
                si.setStartedAt(now);
                si.setFinishedAt(now);
                si.setDurationMs(0L);
                si.setErrorSummary("stage-cache hit (skipped)");
                stageRepo.save(si);
            }
        }
    }

    /**
     * Resume-from-failed-run — 옛 run 의 disk parquet 들을 새 schema 에 복원.
     *   - {oldOutput}/parquet1/{asisTable}.parquet → asis_{asisTable} (Extract 산출물)
     *   - {oldOutput}/parquet2/{tobeTable}.parquet → tobe_{tobeTable} (Transform 산출물)
     * 옛 outputDir 은 RunHistory.metadata.outputDir 에 박제됨 (RunService.recordOutputDir).
     * 옛 run 이 그 추적 코드 도입 전이라 outputDir null 이면 silent skip — 후속 stage 가 데이터 부재로 fail.
     */
    private void restoreParquetFromOldRun(StageContext ctx, String oldRunId) {
        RunHistory oldRh = runRepo.findById(oldRunId).orElse(null);
        if (oldRh == null) {
            log.warn("Resume: old run {} not found — skipping parquet restore", oldRunId);
            return;
        }
        Object oldDirObj = oldRh.getMetadata() == null ? null : oldRh.getMetadata().get("outputDir");
        if (!(oldDirObj instanceof String oldDirStr) || oldDirStr.isBlank()) {
            log.warn("Resume: old run {} has no outputDir metadata — skipping parquet restore", oldRunId);
            return;
        }
        java.nio.file.Path oldDir = java.nio.file.Paths.get(oldDirStr);
        if (!java.nio.file.Files.isDirectory(oldDir)) {
            log.warn("Resume: old outputDir not found on disk: {}", oldDir);
            return;
        }
        String schema = ctx.getDuckdbSchema();
        try (java.sql.Statement st = duckDbService.statement()) {
            st.execute("CREATE SCHEMA IF NOT EXISTS \"" + schema.replace("\"", "\"\"") + "\"");
            restoreParquetDir(st, schema, oldDir.resolve("parquet1"), "asis_");
            restoreParquetDir(st, schema, oldDir.resolve("parquet2"), "tobe_");
        } catch (Exception e) {
            log.warn("Resume: parquet restore failed runId={} oldRunId={}: {}",
                    ctx.getRunHistory().getId(), oldRunId, e.getMessage());
        }
    }

    /** 한 디렉터리의 *.parquet 파일들을 모두 새 schema 의 {prefix}{filename} 테이블로 복원. */
    private void restoreParquetDir(java.sql.Statement st, String schema,
                                   java.nio.file.Path dir, String tablePrefix) throws Exception {
        if (!java.nio.file.Files.isDirectory(dir)) {
            log.info("Resume: dir not present, skip {}", dir);
            return;
        }
        try (var stream = java.nio.file.Files.list(dir)) {
            for (java.nio.file.Path p : stream.filter(java.nio.file.Files::isRegularFile).toList()) {
                String fname = p.getFileName().toString();
                if (!fname.toLowerCase().endsWith(".parquet")) continue;
                String tableBase = fname.substring(0, fname.length() - ".parquet".length());
                String fqTable = "\"" + schema.replace("\"", "\"\"") + "\".\""
                        + (tablePrefix + tableBase).replace("\"", "\"\"") + "\"";
                String escapedPath = p.toString().replace("\\", "/").replace("'", "''");
                st.execute("CREATE OR REPLACE TABLE " + fqTable
                        + " AS SELECT * FROM read_parquet('" + escapedPath + "')");
                log.info("Resume: restored {} from {}", fqTable, p);
            }
        }
    }
}

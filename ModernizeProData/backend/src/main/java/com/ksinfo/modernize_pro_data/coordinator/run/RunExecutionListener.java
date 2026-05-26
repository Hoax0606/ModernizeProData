package com.ksinfo.modernize_pro_data.coordinator.run;

import com.ksinfo.modernize_pro_data.coordinator.mapping.MappingTableBinding;
import com.ksinfo.modernize_pro_data.coordinator.mapping.MappingTableBindingRepository;
import com.ksinfo.modernize_pro_data.coordinator.run.stage.StageInstance;
import com.ksinfo.modernize_pro_data.coordinator.run.stage.StageInstanceRepository;
import com.ksinfo.modernize_pro_data.coordinator.runlog.RunLogIngestService;
import com.ksinfo.modernize_pro_data.coordinator.site.Project;
import com.ksinfo.modernize_pro_data.coordinator.site.ProjectRepository;
import com.ksinfo.modernize_pro_data.coordinator.site.Site;
import com.ksinfo.modernize_pro_data.coordinator.site.SiteRepository;
import com.ksinfo.modernize_pro_data.coordinator.worker.RunOutputPathResolver;
import com.ksinfo.modernize_pro_data.coordinator.worker.StageContext;
import com.ksinfo.modernize_pro_data.coordinator.worker.WorkerExecutor;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.scheduling.annotation.Async;
import org.springframework.stereotype.Component;
import org.springframework.transaction.event.TransactionPhase;
import org.springframework.transaction.event.TransactionalEventListener;

import java.nio.file.Path;
import java.util.List;

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

    @TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
    @Async
    public void onRunStarted(RunStartedEvent event) {
        String runId = event.runId();
        String projectId = event.projectId();
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
            List<StageInstance> stages = stageRepo.findByRunIdOrderBySeqAsc(runId);

            long runIndex = runRepo.countByProjectId(projectId);   // 이 run 까지 포함 = 1..N
            Path outputDir = outputResolver.resolveAndCreate(projectId, runIndex, rh.getStartedAt());
            String duckdbSchema = "run_" + runId.replace("-", "_");

            ctx = StageContext.builder()
                    .runHistory(rh)
                    .project(project)
                    .site(site)
                    .bindings(bindings)
                    .stages(stages)
                    .outputDir(outputDir)
                    .duckdbSchema(duckdbSchema)
                    .build();
        } catch (Exception e) {
            log.error("Run setup failed runId={}", runId, e);
            safeFail(runId, "setup failed: " + e.getMessage());
            return;
        }

        runLogIngest.openRun(runId, projectId);
        try {
            workerExecutor.execute(ctx);
            runService.completeRun(runId, null, null);
        } catch (Exception e) {
            log.error("Run execution failed runId={}", runId, e);
            safeFail(runId, e.getMessage());
        } finally {
            try {
                runLogIngest.closeRun(runId);
            } catch (Exception e) {
                log.warn("Failed to close RunLog runId={}", runId, e);
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
}

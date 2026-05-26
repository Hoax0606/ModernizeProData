package com.ksinfo.modernize_pro_data.coordinator.run;

import com.ksinfo.modernize_pro_data.coordinator.dispatch.WorkerDispatcher;
import com.ksinfo.modernize_pro_data.coordinator.site.Project;
import com.ksinfo.modernize_pro_data.coordinator.site.ProjectRepository;
import com.ksinfo.modernize_pro_data.coordinator.site.Site;
import com.ksinfo.modernize_pro_data.coordinator.site.SiteRepository;
import com.ksinfo.modernize_pro_data.coordinator.site.Snapshot;
import com.ksinfo.modernize_pro_data.coordinator.site.SnapshotRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.OffsetDateTime;
import java.util.Optional;

/**
 * Run service — 3 系統 (Quartz / CLI / REST) すべての共通実行入口.
 *
 * 処理フロー (1 トランザクション内):
 *   1. Validate     — project / phase / snapshot / environment
 *   2. Lock         — projects.run_status を SELECT FOR UPDATE で idle 確認
 *   3. 状態遷移    — run_history INSERT (status=running) + projects.run_status='running'
 *   4. WS dispatch  — Worker /topic/worker/default/tasks へ RUN_START
 *   5. Return       — RunResult.started(runId) を即返却 (Job 完了は待たない)
 *
 * 完了経路は Worker → REST callback (/internal/runs/{id}/complete or /fail) で
 * 別途行われ、その際に run_history.status と projects.run_status='idle' を更新.
 *
 * 二重起動防止: PESSIMISTIC_WRITE ロックで projects 行を排他取得、run_status が
 * idle (or NULL) でなければ LOCKED で即 return.
 */
@Service
@RequiredArgsConstructor
@Slf4j
public class RunService {

    /** projects.run_status 初期値 (NULL 或は 'idle' を idle と扱う). */
    private static final String STATUS_IDLE    = "idle";
    private static final String STATUS_RUNNING = "running";

    /** cutover run は production 環境のみで実行可. */
    private static final String PROD_ENV = "prod";

    private final ProjectRepository projectRepo;
    private final RunHistoryRepository runHistoryRepo;
    private final SnapshotRepository snapshotRepo;
    private final SiteRepository siteRepo;
    private final WorkerDispatcher workerDispatcher;

    /**
     * Run を起動する. 3 系統 (Nightly Quartz / CLI / REST) のすべてがこの入口を通る.
     *
     * @param projectId     対象 project
     * @param runType       何を実行するか
     * @param triggerSource 経路 (監査用、動作には影響しない)
     * @param requestedBy   起動要求主体 ('system' / user id / etc.)
     * @param credentialId  REST/CLI の場合 api_credentials.id、Nightly/UI は NULL
     * @return RunResult — STARTED / REJECTED / LOCKED
     */
    @Transactional
    public RunResult startRun(String projectId,
                              RunType runType,
                              TriggerSource triggerSource,
                              String requestedBy,
                              String credentialId) {

        // 1. Validate — project 存在 (FOR UPDATE で同時にロック取得)
        Project project = projectRepo.findByIdForUpdate(projectId).orElse(null);
        if (project == null) {
            log.warn("startRun rejected: project not found id={}", projectId);
            return RunResult.rejected("project not found: " + projectId);
        }

        // Phase 制約 — runType に対応する phase であること.
        // resolveRunTypeFromPhase 의 역방향 매칭 — ready phase 에서 cutover trigger.
        String expectedPhase = expectedPhaseForRunType(runType);
        if (!expectedPhase.equals(project.getPhase())) {
            log.warn("startRun rejected: phase mismatch projectId={} phase={} runType={} expected={}",
                    projectId, project.getPhase(), runType, expectedPhase);
            return RunResult.rejected("phase '" + project.getPhase()
                    + "' does not allow runType '" + runType
                    + "' (expected phase '" + expectedPhase + "')");
        }

        // Cutover は production 環境のみ
        if (runType == RunType.cutover) {
            Site site = siteRepo.findById(project.getSiteId()).orElse(null);
            if (site == null) {
                return RunResult.rejected("site not found: " + project.getSiteId());
            }
            if (!PROD_ENV.equals(site.getEnvironment())) {
                log.warn("startRun rejected: cutover on non-prod environment={}", site.getEnvironment());
                return RunResult.rejected("cutover only allowed in production environment");
            }
        }

        // 2. Lock check — run_status が idle (or NULL) でなければ LOCKED
        String currentStatus = project.getRunStatus();
        if (currentStatus != null && !STATUS_IDLE.equals(currentStatus)) {
            log.info("startRun locked: projectId={} run_status={}", projectId, currentStatus);
            return RunResult.locked("project already in run_status: " + currentStatus);
        }

        // 3. Snapshot 解決
        //   - rehearsal: latest approved 'mapping' snapshot
        //   - cutover  : latest approved 'cutover' snapshot (必須)
        //   - test     : snapshot 任意 (analysis 段階で未確定)
        String snapshotId = resolveSnapshotId(projectId, runType);
        if (runType == RunType.cutover && snapshotId == null) {
            return RunResult.rejected("no approved cutover snapshot for project " + projectId);
        }

        // 4. 状態遷移 — run_history INSERT + project.run_status='running'
        RunHistory rh = RunHistory.create(projectId, runType, triggerSource,
                requestedBy, credentialId, snapshotId);
        rh.setStatus(RunStatus.running);
        // worker = 이 project 의 실행 담당 (admin user = ROLE_WORKER 의 username).
        // executionAssignee 가 미할당이면 일반 assignee 를 fallback, 둘 다 없으면 null.
        // (실제 분산 실행은 아직 미구현이지만, audit 로서 "이 run 의 책임자" 를 기록.)
        rh.setWorkerId(resolveWorkerForProject(project));
        runHistoryRepo.save(rh);

        project.setRunStatus(STATUS_RUNNING);
        projectRepo.save(project);

        // 5. WS dispatch — Worker へ RUN_START
        try {
            workerDispatcher.dispatchRunStart(rh);
        } catch (Exception e) {
            // WS push 失敗時はトランザクション巻き戻しを誘発するため例外を伝播
            // → run_history INSERT も project.run_status='running' もロールバックされる
            log.error("WS dispatch failed for runId={}, rolling back", rh.getId(), e);
            throw new RuntimeException("Failed to dispatch run to Worker: " + e.getMessage(), e);
        }

        log.info("startRun started runId={} projectId={} runType={} trigger={}",
                rh.getId(), projectId, runType, triggerSource);
        return RunResult.started(rh.getId());
    }

    /**
     * Worker からの complete callback 用 — run を成功完了状態に遷移.
     *
     * @param runId               対象 run
     * @param batchJobExecutionId Worker 側 Spring Batch JOB_EXECUTION_ID (任意)
     * @param durationMs          所要時間 (任意、Worker 側計測値を信頼)
     * @return 更新後の RunHistory
     */
    @Transactional
    public RunHistory completeRun(String runId, Long batchJobExecutionId, Long durationMs) {
        return finishRun(runId, RunStatus.success, batchJobExecutionId, durationMs, null);
    }

    /** Worker からの fail callback 用 — run を失敗状態に遷移. */
    @Transactional
    public RunHistory failRun(String runId, Long batchJobExecutionId, Long durationMs, String errorMessage) {
        return finishRun(runId, RunStatus.failed, batchJobExecutionId, durationMs, errorMessage);
    }

    /**
     * 中断 — run_history.status='aborted' + projects.run_status='idle' 复귀.
     * 使い道: 사용자가 명시적으로 취소 / 시간 초과 sweep / dev 환경에서 stuck 解除.
     * fail 와의 차이: 시스템 에러가 아니라 의도된 중단 (audit 上 구별).
     */
    @Transactional
    public RunHistory abortRun(String runId, String reason) {
        return finishRun(runId, RunStatus.aborted, null, null, reason);
    }

    private RunHistory finishRun(String runId,
                                 RunStatus finalStatus,
                                 Long batchJobExecutionId,
                                 Long durationMs,
                                 String errorMessage) {
        RunHistory rh = runHistoryRepo.findById(runId)
                .orElseThrow(() -> new IllegalArgumentException("run not found: " + runId));

        OffsetDateTime finishedAt = OffsetDateTime.now();
        rh.setStatus(finalStatus);
        rh.setFinishedAt(finishedAt);
        rh.setBatchJobExecutionId(batchJobExecutionId);
        // durationMs 가 caller (Worker / dev sim) 로부터 명시되면 우선 사용, null 이면
        // started_at → finished_at 차이로 자동 산출. 이로써 Worker callback 가 duration
        // 을 빠뜨려도 정확한 소요시간이 기록되고, dev page 의 mark complete 도 실제
        // running 시간을 반영한다.
        if (durationMs != null) {
            rh.setDurationMs(durationMs);
        } else if (rh.getStartedAt() != null) {
            rh.setDurationMs(java.time.Duration.between(rh.getStartedAt(), finishedAt).toMillis());
        }
        rh.setErrorMessage(errorMessage);
        runHistoryRepo.save(rh);

        // project.run_status を idle へ戻す (ロック解放)
        Project project = projectRepo.findByIdForUpdate(rh.getProjectId())
                .orElseThrow(() -> new IllegalStateException("project disappeared: " + rh.getProjectId()));
        project.setRunStatus(STATUS_IDLE);

        // rehearsal の場合は last_run_at を更新 (Misfire 判定用)
        if (rh.getRunType() == RunType.rehearsal) {
            project.setScheduleLastRunAt(OffsetDateTime.now());
        }
        projectRepo.save(project);

        log.info("finishRun runId={} status={} durationMs={}", runId, finalStatus, durationMs);
        return rh;
    }

    /**
     * Project phase 로부터 scheduler 가 起動해야 할 runType 을 결정.
     * 스케줄러 (내부 Quartz / 외부 bulk / 외부 single runType 省略時) 가 사용.
     *
     * Phase semantics (2026-05-24 update):
     *   - test       → RunType.test       (dry-run test 実行可)
     *   - rehearsal  → RunType.rehearsal  (dry-run rehearsal 実行可)
     *   - ready      → RunType.cutover    (cutover 実行準備完了 — 本番切替を起動)
     *   - cutover    → empty              (= 既に cutover 実行中、新 run は受け付けない)
     *   - その他 (planning / analysis / sign-off / hypercare / done) → empty
     *
     * cutover 終了後は phase が hypercare に遷移する想定.
     */
    /**
     * RunType 별 trigger 가능한 phase. resolveRunTypeFromPhase 의 역방향.
     *   - test       → phase=test
     *   - rehearsal  → phase=rehearsal
     *   - cutover    → phase=ready (CLAUDE.md: ready 에서 cutover 起動)
     */
    public static String expectedPhaseForRunType(RunType runType) {
        return switch (runType) {
            case test      -> "test";
            case rehearsal -> "rehearsal";
            case cutover   -> "ready";
        };
    }

    public static Optional<RunType> resolveRunTypeFromPhase(String phase) {
        if (phase == null) return Optional.empty();
        return switch (phase) {
            case "test"      -> Optional.of(RunType.test);
            case "rehearsal" -> Optional.of(RunType.rehearsal);
            case "ready"     -> Optional.of(RunType.cutover);
            default          -> Optional.empty();
        };
    }

    /**
     * Run 의 worker (책임자) 를 project 의 assignment 에서 解決.
     * executionAssignee 우선 → assignee fallback → 미할당이면 null.
     */
    private String resolveWorkerForProject(Project project) {
        if (project.getExecutionAssignee() != null) return project.getExecutionAssignee();
        if (project.getAssignee() != null) return project.getAssignee();
        return null;
    }

    private String resolveSnapshotId(String projectId, RunType runType) {
        String snapshotType = switch (runType) {
            case rehearsal -> "mapping";
            case cutover   -> "cutover";
            case test      -> null;
        };
        if (snapshotType == null) {
            return null;
        }
        Optional<Snapshot> latest = snapshotRepo.findLatestApprovedByProjectIdAndType(projectId, snapshotType);
        return latest.map(Snapshot::getId).orElse(null);
    }
}

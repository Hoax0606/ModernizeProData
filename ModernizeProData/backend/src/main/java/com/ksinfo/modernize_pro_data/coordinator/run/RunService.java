package com.ksinfo.modernize_pro_data.coordinator.run;

import com.ksinfo.modernize_pro_data.coordinator.dispatch.WorkerDispatcher;
import com.ksinfo.modernize_pro_data.coordinator.worker.WorkerNodeService;
import com.ksinfo.modernize_pro_data.coordinator.mapping.MappingTableBinding;
import com.ksinfo.modernize_pro_data.coordinator.mapping.MappingTableBindingRepository;
import com.ksinfo.modernize_pro_data.coordinator.run.stage.StageCatalog;
import com.ksinfo.modernize_pro_data.coordinator.run.stage.StageInstance;
import com.ksinfo.modernize_pro_data.coordinator.run.stage.StageInstanceRepository;
import com.ksinfo.modernize_pro_data.coordinator.run.stage.StageStatus;
import com.ksinfo.modernize_pro_data.coordinator.run.stage.StageTableResult;
import com.ksinfo.modernize_pro_data.coordinator.run.stage.StageTableResultRepository;
import com.ksinfo.modernize_pro_data.coordinator.run.stage.StageTableStatus;
import com.ksinfo.modernize_pro_data.coordinator.site.Project;
import com.ksinfo.modernize_pro_data.coordinator.site.ProjectRepository;
import com.ksinfo.modernize_pro_data.coordinator.site.Site;
import com.ksinfo.modernize_pro_data.coordinator.site.SiteRepository;
import com.ksinfo.modernize_pro_data.coordinator.site.Snapshot;
import com.ksinfo.modernize_pro_data.coordinator.site.SnapshotRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.messaging.simp.SimpMessagingTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.OffsetDateTime;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
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

    /** cutover run は production 環境のみで実行可. FE の ProjectEnvironment 値 'production' と一致させる. */
    private static final String PROD_ENV = "production";

    /** Phase 자동 진행 순서 (planning → done). 진행만 하고 후퇴는 안 함. */
    private static final List<String> PHASE_ORDER = List.of(
            "planning", "analysis", "test", "sign-off", "rehearsal", "ready", "cutover", "hypercare", "done"
    );

    private final ProjectRepository projectRepo;
    private final RunHistoryRepository runHistoryRepo;
    private final SnapshotRepository snapshotRepo;
    private final SiteRepository siteRepo;
    private final WorkerDispatcher workerDispatcher;
    private final WorkerNodeService workerNodeService;

    @org.springframework.beans.factory.annotation.Value("${modernize.coordinator.self-username:master}")
    private String coordinatorSelfUsername;
    private final StageInstanceRepository stageInstanceRepo;
    private final StageTableResultRepository stageTableResultRepo;
    private final MappingTableBindingRepository bindingRepo;
    private final ApplicationEventPublisher eventPublisher;
    private final RunControlRegistry runControlRegistry;
    private final SimpMessagingTemplate stomp;
    private final com.ksinfo.modernize_pro_data.coordinator.site.SnapshotExecutionContextService snapshotExecutionContextService;

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
        return startRun(projectId, runType, triggerSource, requestedBy, credentialId, null, false);
    }

    @Transactional
    public RunResult startRun(String projectId,
                              RunType runType,
                              TriggerSource triggerSource,
                              String requestedBy,
                              String credentialId,
                              List<String> tables) {
        return startRun(projectId, runType, triggerSource, requestedBy, credentialId, tables, false);
    }

    /**
     * 부분 실행(tables) + stage-cache(useCache) 지원. tables=null/empty 면 전체, useCache=true 면 직전 CP2 재사용 시도.
     * 두 플래그는 RunHistory.metadata 에 저장 → RunExecutionListener 가 사용.
     */
    @Transactional
    public RunResult startRun(String projectId,
                              RunType runType,
                              TriggerSource triggerSource,
                              String requestedBy,
                              String credentialId,
                              List<String> tables,
                              boolean useCache) {

        // 1. Validate — project 存在 (FOR UPDATE で同時にロック取得)
        Project project = projectRepo.findByIdForUpdate(projectId).orElse(null);
        if (project == null) {
            log.warn("startRun rejected: project not found id={}", projectId);
            return RunResult.rejected("project not found: " + projectId);
        }

        // Environment-based 가드 — Pre-flight 8 체크가 frontend 1차 방어선이라
        // backend 는 environment 기준만 검사. phase 가드는 cutover 만.
        //   - cutover  : prod 환경 + phase='ready' 만
        //   - test/rehearsal : non-prod 환경에서 모든 phase 허용 (pre-flight 가 막음)
        Site site = siteRepo.findById(project.getSiteId()).orElse(null);
        if (site == null) {
            return RunResult.rejected("site not found: " + project.getSiteId());
        }
        boolean isProd = PROD_ENV.equals(site.getEnvironment());

        if (runType == RunType.cutover) {
            if (!isProd) {
                log.warn("startRun rejected: cutover on non-prod environment={}", site.getEnvironment());
                return RunResult.rejected("cutover only allowed in production environment");
            }
            if (!"ready".equals(project.getPhase())) {
                log.warn("startRun rejected: cutover requires phase=ready projectId={} phase={}",
                        projectId, project.getPhase());
                return RunResult.rejected("cutover requires phase='ready' (current: " + project.getPhase() + ")");
            }
        } else {
            if (isProd) {
                log.warn("startRun rejected: runType={} on prod environment", runType);
                return RunResult.rejected("runType '" + runType + "' not allowed in production environment");
            }
        }

        // 2. Lock check — 실행 중 (running / paused) 만 LOCKED.
        // idle / null / completed 는 새 run trigger 허용.
        // completed = 이전 run 결과 (frontend mock simulation 잔재 포함) — 새 run 막을 이유 없음.
        String currentStatus = project.getRunStatus();
        boolean isActuallyRunning = STATUS_RUNNING.equals(currentStatus) || "paused".equals(currentStatus);
        if (isActuallyRunning) {
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

        // 3.5. Worker dispatch decision — assignee 의 Worker daemon 이 등록 + heartbeat 살아있으면
        //   그 worker 로 WS push (RunExecutionListener 가 Coordinator local 실행 skip).
        //   offline / 미등록 / 미할당 / Coordinator self 면 그냥 Coordinator 가 local 실행 fallback.
        //   (REJECT 정책은 운영 부담이 커서 fallback 으로 통일 — Worker 안 켜져있어도 일이 멈추지 않게.)
        String resolvedWorker = resolveWorkerForProject(project);

        // 4. 状態遷移 — run_history INSERT + project.run_status='running'
        List<String> selectedTables = (tables == null || tables.isEmpty()) ? null : tables;
        RunHistory rh = RunHistory.create(projectId, runType, triggerSource,
                requestedBy, credentialId, snapshotId);
        rh.setStatus(RunStatus.running);
        Map<String, Object> meta = new HashMap<>();
        if (selectedTables != null) meta.put("selectedTables", selectedTables);
        if (useCache) meta.put("useCache", true);
        if (!meta.isEmpty()) rh.setMetadata(meta);
        rh.setWorkerId(resolvedWorker);
        runHistoryRepo.save(rh);

        project.setRunStatus(STATUS_RUNNING);
        maybeAdvancePhase(project, runType);
        projectRepo.save(project);

        // 5. Stage pre-create — runType 별 stage list 를 pending 상태로 사전 등록.
        //    tables_total 은 run start 시점의 binding 수로 materialize (mid-run 변경 무시).
        //    같은 @Transactional 안 — 이후 WS dispatch 실패 시 함께 rollback.
        List<String> stageKeys = StageCatalog.forRunType(runType);
        int tablesTotal = selectedTables == null
                ? (int) bindingRepo.countByProjectId(projectId)
                : (int) bindingRepo.findByProjectId(projectId).stream()
                        .filter(b -> selectedTables.contains(b.getTobeTable())).count();
        int seq = 1;
        for (String stageKey : stageKeys) {
            stageInstanceRepo.save(StageInstance.create(rh.getId(), stageKey, seq++, tablesTotal));
        }

        // 6. WS dispatch — Worker へ RUN_START
        try {
            workerDispatcher.dispatchRunStart(rh);
        } catch (Exception e) {
            // WS push 失敗時はトランザクション巻き戻しを誘発するため例外を伝播
            // → run_history INSERT も project.run_status='running' もロールバックされる
            log.error("WS dispatch failed for runId={}, rolling back", rh.getId(), e);
            throw new RuntimeException("Failed to dispatch run to Worker: " + e.getMessage(), e);
        }

        // 7. Local stage 실행 trigger — transaction commit 후 별 thread 에서 7-stage 실행.
        //    @TransactionalEventListener(AFTER_COMMIT) + @Async (RunExecutionListener).
        eventPublisher.publishEvent(new RunStartedEvent(rh.getId(), projectId));

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
        runControlRegistry.cancel(runId);   // paused 로 대기 중인 executor 깨워서 중단
        return finishRun(runId, RunStatus.aborted, null, null, reason);
    }

    /**
     * 타임아웃 — 너무 오래 running 인 run 을 timed_out 으로 종료 (RunTimeoutSweeper 가 호출).
     * abort 와 구별: 시스템이 임계 초과로 자동 종료한 것.
     */
    @Transactional
    public RunHistory timeoutRun(String runId, String reason) {
        runControlRegistry.cancel(runId);
        return finishRun(runId, RunStatus.timed_out, null, null, reason);
    }

    /** 실행 중 run 일시정지 — running 일 때만. projects.run_status='paused' 로 잠금 유지. */
    @Transactional
    public RunHistory pauseRun(String runId) {
        RunHistory rh = runHistoryRepo.findById(runId)
                .orElseThrow(() -> new IllegalArgumentException("run not found: " + runId));
        if (rh.getStatus() != RunStatus.running) {
            log.info("pauseRun ignored — runId={} status={}", runId, rh.getStatus());
            return rh;
        }
        rh.setStatus(RunStatus.paused);
        runHistoryRepo.save(rh);
        Project project = projectRepo.findByIdForUpdate(rh.getProjectId())
                .orElseThrow(() -> new IllegalStateException("project disappeared: " + rh.getProjectId()));
        project.setRunStatus("paused");
        projectRepo.save(project);
        runControlRegistry.pause(runId);
        log.info("pauseRun runId={}", runId);
        return rh;
    }

    /** 일시정지된 run 재개 — paused 일 때만. */
    @Transactional
    public RunHistory resumeRun(String runId) {
        RunHistory rh = runHistoryRepo.findById(runId)
                .orElseThrow(() -> new IllegalArgumentException("run not found: " + runId));
        if (rh.getStatus() != RunStatus.paused) {
            log.info("resumeRun ignored — runId={} status={}", runId, rh.getStatus());
            return rh;
        }
        rh.setStatus(RunStatus.running);
        runHistoryRepo.save(rh);
        Project project = projectRepo.findByIdForUpdate(rh.getProjectId())
                .orElseThrow(() -> new IllegalStateException("project disappeared: " + rh.getProjectId()));
        project.setRunStatus(STATUS_RUNNING);
        projectRepo.save(project);
        runControlRegistry.resume(runId);
        log.info("resumeRun runId={}", runId);
        return rh;
    }

    private RunHistory finishRun(String runId,
                                 RunStatus finalStatus,
                                 Long batchJobExecutionId,
                                 Long durationMs,
                                 String errorMessage) {
        RunHistory rh = runHistoryRepo.findById(runId)
                .orElseThrow(() -> new IllegalArgumentException("run not found: " + runId));

        // 이미 종료된 run 은 재종료 skip — abort/timeout/완료 경합 안전
        // (executor 가 cancel 후 정상 return → listener 가 completeRun 불러도 기존 상태 보존).
        if (isTerminal(rh.getStatus())) {
            log.info("finishRun skip — runId={} already terminal status={}", runId, rh.getStatus());
            return rh;
        }

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

        // Snapshot 박제 — run 이 snapshot_id 와 함께 시작됐다면 그 snapshot 의 execution_context
        // 를 이 run 결과로 덮어쓴다. 성공/실패/abort/timeout 어떤 경로든 동일 hook.
        // 사용자 결정: 같은 snapshot 으로 여러 번 run 시 매번 덮어쓰기.
        snapshotExecutionContextService.recordExecutionContext(rh);

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

        /* 실시간 진행 알림 — run 최종 상태 도달. FE 가 invalidate 해서 status chip / 버튼 즉시 갱신. */
        try {
            Map<String, Object> payload = new HashMap<>();
            payload.put("type", "run");
            payload.put("status", finalStatus.name());
            if (errorMessage != null) payload.put("errorMessage", errorMessage);
            stomp.convertAndSend("/topic/run/" + runId + "/progress", payload);
        } catch (Exception e) {
            log.debug("Run finish broadcast failed runId={}: {}", runId, e.getMessage());
        }

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
     * Project phase 로부터 default runType 결정.
     *   - rehearsal → RunType.rehearsal
     *   - ready     → RunType.cutover (단 prod 환경 가드 통과 필요)
     *   - 그 외 (planning/analysis/test/sign-off/cutover/hypercare/done) → RunType.test
     *
     * Env-based 정책: non-prod 모든 phase 에서 default=test runType 으로 trigger 가능.
     * Pre-flight 가 frontend 에서 미준비 상태 막음.
     */
    public static Optional<RunType> resolveRunTypeFromPhase(String phase) {
        if (phase == null) return Optional.empty();
        return switch (phase) {
            case "rehearsal" -> Optional.of(RunType.rehearsal);
            case "ready"     -> Optional.of(RunType.cutover);
            default          -> Optional.of(RunType.test);
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

    /** stage-cache — run 성공 후 fingerprint + parquet2Dir 을 metadata 에 기록 (다음 run 재사용 판정용). */
    @Transactional
    public void recordCacheMeta(String runId, String fingerprint, String parquet2Dir) {
        RunHistory rh = runHistoryRepo.findById(runId).orElse(null);
        if (rh == null) return;
        Map<String, Object> md = new HashMap<>(rh.getMetadata() == null ? Map.of() : rh.getMetadata());
        md.put("cacheFingerprint", fingerprint);
        md.put("parquet2Dir", parquet2Dir);
        rh.setMetadata(md);
        runHistoryRepo.save(rh);
    }

    private static boolean isTerminal(RunStatus s) {
        return s == RunStatus.success || s == RunStatus.failed
                || s == RunStatus.aborted || s == RunStatus.timed_out;
    }

    /**
     * Run 起動 시 phase 자동 진행. 현재보다 앞으로만 이동, 후퇴 없음.
     *   - test     → 'test'
     *   - rehearsal → 'rehearsal'
     *   - cutover  → no-op (이미 'ready' 가드 통과 — cutover 라이프사이클은 별도 작업)
     * 데모 모드 FE 가 자체적으로 하던 setProjectPhaseAndRunStatus 의 phase 부분을 BE 로 이관.
     * 참고 선례: DdlImportService.importDdl 의 planning → analysis 자동 전이.
     */
    private void maybeAdvancePhase(Project project, RunType runType) {
        String desired = switch (runType) {
            case test -> "test";
            case rehearsal -> "rehearsal";
            case cutover -> null;
        };
        if (desired == null) return;
        int curIdx = PHASE_ORDER.indexOf(project.getPhase());
        int desIdx = PHASE_ORDER.indexOf(desired);
        if (curIdx >= 0 && desIdx > curIdx) {
            log.info("Phase auto-advance projectId={} {} -> {} (runType={})",
                    project.getId(), project.getPhase(), desired, runType);
            project.setPhase(desired);
        }
    }

    /**
     * 어느 snapshot 으로 run 하는지 결정. 우선순위:
     *   1. 프로젝트에 baseline (pinned) snapshot 이 있으면 그것 — 사용자가 명시적으로 고정한 것.
     *   2. cutover runType 이면 latest approved cutover snapshot.
     *   3. rehearsal runType 이면 latest approved mapping snapshot.
     *   4. test runType 이면 latest mapping snapshot (approved 아니어도) — test 는 ad-hoc 이지만
     *      그래도 snapshot 과 연결해서 그 snapshot 의 execution_context 에 박제될 수 있도록.
     *
     * cutover 만 snapshot 필수 (caller 가 null 면 reject). 다른 runType 은 snapshot 이 없어도 진행.
     */
    private String resolveSnapshotId(String projectId, RunType runType) {
        // 1) baseline pinned snapshot 우선 — 사용자 선택을 그대로 존중.
        Optional<Snapshot> pinned = snapshotRepo.findByProjectIdAndBaselineTrue(projectId);
        if (pinned.isPresent()) {
            return pinned.get().getId();
        }
        // 2) 없으면 runType 별 fallback.
        return switch (runType) {
            case cutover -> snapshotRepo.findLatestApprovedByProjectIdAndType(projectId, "cutover")
                    .map(Snapshot::getId).orElse(null);
            case rehearsal -> snapshotRepo.findLatestApprovedByProjectIdAndType(projectId, "mapping")
                    .map(Snapshot::getId).orElse(null);
            case test -> snapshotRepo.findLatestByProjectIdAndType(projectId, "mapping")
                    .map(Snapshot::getId).orElse(null);
        };
    }

    // ============================================================
    // Stage lifecycle — Worker callback 用 (run-level の startRun/completeRun/failRun 와는 분리).
    //   - startStage:        pending → running, started_at = NOW
    //   - completeStage:     running → success | failed (continue-on-error 모델)
    //   - recordTableResult: stage 안 1 테이블 결과 upsert
    // ============================================================

    @Transactional
    public StageInstance startStage(String runId, String stageKey) {
        StageInstance si = stageInstanceRepo.findByRunIdAndStageKey(runId, stageKey)
                .orElseThrow(() -> new IllegalArgumentException(
                        "stage_instance not found: runId=" + runId + " stageKey=" + stageKey));
        if (si.getStatus() != StageStatus.pending) {
            log.warn("startStage already started: runId={} stageKey={} status={}",
                    runId, stageKey, si.getStatus());
            return si;
        }
        si.setStatus(StageStatus.running);
        si.setStartedAt(OffsetDateTime.now());
        return stageInstanceRepo.save(si);
    }

    @Transactional
    public StageInstance completeStage(String runId, String stageKey,
                                       int tablesSuccess, int tablesFailed,
                                       String errorSummary) {
        StageInstance si = stageInstanceRepo.findByRunIdAndStageKey(runId, stageKey)
                .orElseThrow(() -> new IllegalArgumentException(
                        "stage_instance not found: runId=" + runId + " stageKey=" + stageKey));

        OffsetDateTime finishedAt = OffsetDateTime.now();
        si.setStatus(tablesFailed == 0 ? StageStatus.success : StageStatus.failed);
        si.setTablesSuccess(tablesSuccess);
        si.setTablesFailed(tablesFailed);
        si.setErrorSummary(errorSummary);
        si.setFinishedAt(finishedAt);
        if (si.getStartedAt() != null) {
            si.setDurationMs(java.time.Duration.between(si.getStartedAt(), finishedAt).toMillis());
        }
        log.info("completeStage runId={} stageKey={} status={} success={} failed={}",
                runId, stageKey, si.getStatus(), tablesSuccess, tablesFailed);
        return stageInstanceRepo.save(si);
    }

    @Transactional
    public StageTableResult recordTableResult(String runId, String stageKey,
                                              String bindingId, StageTableStatus status,
                                              Long rowCount, Integer errorCount,
                                              Map<String, Object> errorDetail,
                                              Long durationMs) {
        StageInstance si = stageInstanceRepo.findByRunIdAndStageKey(runId, stageKey)
                .orElseThrow(() -> new IllegalArgumentException(
                        "stage_instance not found: runId=" + runId + " stageKey=" + stageKey));

        StageTableResult str = stageTableResultRepo
                .findByStageInstanceIdAndBindingId(si.getId(), bindingId)
                .orElseGet(() -> {
                    MappingTableBinding b = bindingRepo.findById(bindingId)
                            .orElseThrow(() -> new IllegalArgumentException(
                                    "binding not found: " + bindingId));
                    return StageTableResult.create(si.getId(), bindingId,
                            b.getTobeSchema(), b.getTobeTable());
                });

        OffsetDateTime finishedAt = OffsetDateTime.now();
        str.setStatus(status);
        str.setRowCount(rowCount);
        str.setErrorCount(errorCount);
        str.setErrorDetail(errorDetail);
        if (status != StageTableStatus.running) {
            str.setFinishedAt(finishedAt);
            if (durationMs != null) {
                str.setDurationMs(durationMs);
            } else if (str.getStartedAt() != null) {
                str.setDurationMs(java.time.Duration.between(str.getStartedAt(), finishedAt).toMillis());
            }
        }
        return stageTableResultRepo.save(str);
    }
}

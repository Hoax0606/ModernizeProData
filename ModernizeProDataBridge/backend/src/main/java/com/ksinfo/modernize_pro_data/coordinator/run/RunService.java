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
import com.ksinfo.modernize_pro_data.coordinator.site.AuditLogService;
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

    /**
     * coordinator 가 동시에 코디네이트할 수 있는 in-flight run 총수 상한 (워커 수 무관).
     * 모든 run 의 로그·집계·메타DB·WS 가 coordinator 한 대로 모이므로, 워커를 아무리 늘려도
     * 동시 run 이 이 수를 넘으면 hub 가 포화된다 → 초과분은 reject (안전밸브, 2026-06-10).
     * 기본 32 — 다중 머신 fleet 도 통과하되 폭주 burst(예: 100개 startAll)는 막음. 0/음수 = 무제한.
     */
    @org.springframework.beans.factory.annotation.Value("${modernize.run.max-inflight-coordinated:32}")
    private int maxInflightCoordinated;
    private final StageInstanceRepository stageInstanceRepo;
    private final StageTableResultRepository stageTableResultRepo;
    private final MappingTableBindingRepository bindingRepo;
    private final ApplicationEventPublisher eventPublisher;
    private final RunControlRegistry runControlRegistry;
    private final SimpMessagingTemplate stomp;
    private final com.ksinfo.modernize_pro_data.coordinator.site.SnapshotExecutionContextService snapshotExecutionContextService;
    private final com.ksinfo.modernize_pro_data.coordinator.runlog.RunLogRepository runLogRepository;
    private final AuditLogService auditLogService;

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
        return startRun(projectId, runType, triggerSource, requestedBy, credentialId, null, false, null);
    }

    @Transactional
    public RunResult startRun(String projectId,
                              RunType runType,
                              TriggerSource triggerSource,
                              String requestedBy,
                              String credentialId,
                              List<String> tables) {
        return startRun(projectId, runType, triggerSource, requestedBy, credentialId, tables, false, null);
    }

    @Transactional
    public RunResult startRun(String projectId,
                              RunType runType,
                              TriggerSource triggerSource,
                              String requestedBy,
                              String credentialId,
                              List<String> tables,
                              boolean useCache) {
        return startRun(projectId, runType, triggerSource, requestedBy, credentialId, tables, useCache, null);
    }

    /**
     * 부분 실행(tables) + stage-cache(useCache) + resume-from-failed-run 지원.
     * - tables=null/empty 면 전체.
     * - useCache=true 면 직전 success run 의 CP2 재사용 시도.
     * - resumeFromRunId 있으면 그 옛 run 의 마지막 success stage 이후부터 재개 (Retry 흐름).
     *   처음부터 끝까지 실행하는 게 아니라 그 stage 이전을 모두 success 로 미리 마킹 → executor 가 skip.
     *   RunExecutionListener 가 parquet1/parquet2 도 DuckDB 에 복원.
     * 세 플래그/필드는 RunHistory.metadata 에 저장 → RunExecutionListener 가 사용.
     */
    @Transactional
    public RunResult startRun(String projectId,
                              RunType runType,
                              TriggerSource triggerSource,
                              String requestedBy,
                              String credentialId,
                              List<String> tables,
                              boolean useCache,
                              String resumeFromRunId) {

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
        } else if (runType == RunType.delta) {
            // 델타(CDC 증분 catch-up)는 초기 컷오버 이후 production 에서 매일 반복 실행되는
            // 정상 운영 흐름이므로 prod 허용 + phase 제한 없음. (non-prod 리허설도 허용.)
            // 단 초기 전량적재(= non-delta full run 성공)가 선행돼야 함 — 안 그러면 델타가
            // 빈/반쪽 타깃에 적용됨. FE 버튼 게이트를 백엔드로 이관해 자동(API) 경로까지 강제.
            if (!runHistoryRepo.existsByProjectIdAndStatusAndRunTypeNot(
                    projectId, RunStatus.success, RunType.delta)) {
                log.warn("startRun rejected: delta before any successful initial full load projectId={}", projectId);
                return RunResult.rejected(
                        "delta requires a successful initial full load (non-delta run) first");
            }
        } else {
            if (isProd) {
                log.warn("startRun rejected: runType={} on prod environment", runType);
                return RunResult.rejected("runType '" + runType + "' not allowed in production environment");
            }
        }

        // 2. Lock check — running 만 LOCKED.
        // idle / null / completed 는 새 run trigger 허용.
        // (paused 는 2026-05-29 제거 — Stop + Retry 가 대체.)
        String currentStatus = project.getRunStatus();
        boolean isActuallyRunning = STATUS_RUNNING.equals(currentStatus);
        if (isActuallyRunning) {
            log.info("startRun locked: projectId={} run_status={}", projectId, currentStatus);
            return RunResult.locked("project already in run_status: " + currentStatus);
        }

        // 2.5. In-flight 게이트 (워커 수 무관) — coordinator 가 동시 코디네이트하는 run 총수 상한.
        //   hub(로그·집계·메타DB·WS)가 한 대로 모이므로 동시 run 폭주 시 포화/OOM. 초과분 reject.
        //   (soft cap — 병렬 startAll 의 미세 race 로 약간 초과 가능하나 안전밸브 목적엔 충분.)
        if (maxInflightCoordinated > 0) {
            long inflight = runHistoryRepo.countByStatus(RunStatus.running);
            if (inflight >= maxInflightCoordinated) {
                log.warn("startRun rejected: coordinator in-flight capacity reached ({} >= {}) projectId={}",
                        inflight, maxInflightCoordinated, projectId);
                return RunResult.rejected("coordinator at capacity (" + inflight
                        + " runs in flight, limit " + maxInflightCoordinated + ") — retry shortly");
            }
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
        //   미할당(null) / Coordinator self 면 Coordinator 가 local 실행 (정상 — 4대 풀가동 시 1대 몫).
        String resolvedWorker = resolveWorkerForProject(project);

        // 3.5a. 명시 배정된 Worker 가 offline 이면 REJECT (2026-06-10 OOM 완화).
        //   이전엔 offline 이어도 Coordinator 가 local 로 떠안았다 — 그런데 OOM → heartbeat 처리 지연
        //   → 워커 offline 으로 보임 → 그 run 들이 전부 local 로 떨어짐 → OOM 가중되는 악순환의 핵심.
        //   self / 미할당 run 은 그대로 local 허용 (coordinator 도 executor 다). 남의 워커가 꺼져있는데
        //   coordinator 가 대신 떠안는 경우만 차단 → 운영자가 워커 켜거나 재배정하도록 명확히 안내.
        if (resolvedWorker != null && !resolvedWorker.isBlank()
                && !resolvedWorker.equals(coordinatorSelfUsername)
                && workerNodeService.findOnlineForUsername(resolvedWorker).isEmpty()) {
            log.warn("startRun rejected: assigned worker '{}' offline projectId={}", resolvedWorker, projectId);
            return RunResult.rejected("assigned worker '" + resolvedWorker
                    + "' is offline — start that worker or reassign the project");
        }

        // 3.6. Resume-from-failed-run 검증 — resumeFromRunId 가 주어지면 옛 run 정합성 확인.
        //   조건 통과: same snapshot + same selectedTables (또는 옛 run 의 superset) + 옛 run 의
        //   parquet1/parquet2 가 디스크에 존재. 검증 실패 시 처음부터 fallback (resumeFromStage=null).
        String resumeFromStageKey = null;  // null = 처음부터, "audit" 같은 stage key = 그 stage 부터.
        if (resumeFromRunId != null && !resumeFromRunId.isBlank()) {
            resumeFromStageKey = validateResumeContext(resumeFromRunId, projectId, snapshotId, tables);
            if (resumeFromStageKey == null) {
                log.info("Resume from {} fallback to fresh run (validation failed or no failed stage)", resumeFromRunId);
            } else {
                log.info("Resume from {} : will skip stages before '{}'", resumeFromRunId, resumeFromStageKey);
            }
        }

        // 4. 状態遷移 — run_history INSERT + project.run_status='running'
        List<String> selectedTables = (tables == null || tables.isEmpty()) ? null : tables;
        RunHistory rh = RunHistory.create(projectId, runType, triggerSource,
                requestedBy, credentialId, snapshotId);
        rh.setStatus(RunStatus.running);
        Map<String, Object> meta = new HashMap<>();
        if (selectedTables != null) meta.put("selectedTables", selectedTables);
        if (useCache) meta.put("useCache", true);
        if (resumeFromStageKey != null) {
            meta.put("resumeFromRunId", resumeFromRunId);
            meta.put("resumeFromStage", resumeFromStageKey);
        }
        if (!meta.isEmpty()) rh.setMetadata(meta);
        rh.setWorkerId(resolvedWorker);
        runHistoryRepo.save(rh);

        // run_log partition 을 Coordinator (run_log 의 owner) 가 미리 생성.
        // Worker 가 delegate run 실행 시 partition 생성 권한이 없어 (public schema CREATE
        // 권한 부재) executeRun 의 첫 openRun 호출이 fail 한다. 여기서 미리 만들어 둠.
        try {
            runLogRepository.ensurePartition(rh.getId());
        } catch (Exception e) {
            log.warn("run_log partition pre-create failed runId={} : {}", rh.getId(), e.getMessage());
        }

        project.setRunStatus(STATUS_RUNNING);
        maybeAdvancePhase(project, runType);
        projectRepo.save(project);

        // 5. Stage pre-create — runType 별 stage list 를 pending 상태로 사전 등록.
        //    tables_total 은 run start 시점의 binding 수로 materialize (mid-run 변경 무시).
        //    resumeFromStageKey 가 있으면 그 stage 이전을 모두 success 로 미리 마킹 → executor 가 skip.
        //    같은 @Transactional 안 — 이후 WS dispatch 실패 시 함께 rollback.
        List<String> stageKeys = StageCatalog.forRunType(runType);
        int tablesTotal = selectedTables == null
                ? (int) bindingRepo.countByProjectId(projectId)
                : (int) bindingRepo.findByProjectId(projectId).stream()
                        .filter(b -> selectedTables.contains(b.getTobeTable())).count();
        int seq = 1;
        boolean reachedResumePoint = (resumeFromStageKey == null);
        OffsetDateTime preMarkAt = OffsetDateTime.now();
        for (String stageKey : stageKeys) {
            StageInstance si = StageInstance.create(rh.getId(), stageKey, seq++, tablesTotal);
            if (!reachedResumePoint) {
                if (stageKey.equals(resumeFromStageKey)) {
                    reachedResumePoint = true;   // 이 stage 부터 실행. 이 stage 는 pending 유지.
                } else {
                    // resume 시점 이전 stage — 옛 run 에서 success 로 종료된 stage 들. 미리 마킹.
                    si.setStatus(StageStatus.success);
                    si.setStartedAt(preMarkAt);
                    si.setFinishedAt(preMarkAt);
                    si.setDurationMs(0L);
                    si.setTablesSuccess(tablesTotal);
                    si.setTablesFailed(0);
                    si.setErrorSummary("resumed from " + resumeFromRunId + " — skipped (success)");
                }
            }
            stageInstanceRepo.save(si);
        }

        // 6. 실행 트리거 — transaction commit 후 RunExecutionListener 가 dispatch / local 분기.
        //    이 transaction 안에서 직접 WS push 하면 Worker 가 메시지 받은 시점에 run_history
        //    INSERT 가 아직 commit 전이라 runRepo.findById 가 null → "run not found" race.
        //    @TransactionalEventListener(AFTER_COMMIT) 이 listener 가 push 와 local 실행 둘 다 처리.
        eventPublisher.publishEvent(new RunStartedEvent(rh.getId(), projectId));

        // FE NotificationToast = audit_log 기반. run start/finish 알림은 여기서 audit_log entry 로.
        auditLogService.record(project, requestedBy, "run started")
                .target(runType.name())
                .details(runType.name() + " run started (runId=" + rh.getId() + ")")
                .save();

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
     *
     * Worker dispatch 가 걸렸던 run 이면 그 worker 에도 RUN_CANCEL envelope 을 보내 worker
     * process 의 in-memory RunControlRegistry 가 stage runner 를 깨우게 한다.
     * (Coordinator 의 runControlRegistry.cancel 만 호출해서는 Worker JVM 에 신호가 안 간다.)
     */
    @Transactional
    public RunHistory abortRun(String runId, String reason) {
        runControlRegistry.cancel(runId);   // 다음 stage 경계 진입 전 break.
        dispatchCancelToWorkerIfRemote(runId, reason);
        return finishRun(runId, RunStatus.aborted, null, null, reason);
    }

    /**
     * 타임아웃 — 너무 오래 running 인 run 을 timed_out 으로 종료 (RunTimeoutSweeper 가 호출).
     * abort 와 구별: 시스템이 임계 초과로 자동 종료한 것.
     */
    @Transactional
    public RunHistory timeoutRun(String runId, String reason) {
        runControlRegistry.cancel(runId);
        dispatchCancelToWorkerIfRemote(runId, reason);
        return finishRun(runId, RunStatus.timed_out, null, null, reason);
    }

    /**
     * RunHistory.workerId 가 가리키는 worker 가 Coordinator self 가 아니고 현재 online 이면
     * 그 worker 에 RUN_CANCEL WS push. offline / self / 미할당 인 경우 no-op.
     * 호출자 (abortRun/timeoutRun) 가 finishRun 전에 부르는 게 의도 — worker stage runner
     * 가 cancel signal 받는 시점이 DB 상태 변경보다 약간 앞서도 무방.
     */
    private void dispatchCancelToWorkerIfRemote(String runId, String reason) {
        RunHistory rh = runHistoryRepo.findById(runId).orElse(null);
        if (rh == null) return;
        String assignee = rh.getWorkerId();
        if (assignee == null || assignee.isBlank()) return;
        if (assignee.equals(coordinatorSelfUsername)) return;
        if (workerNodeService.findOnlineForUsername(assignee).isEmpty()) {
            log.info("RUN_CANCEL skipped — worker offline runId={} workerId={}", runId, assignee);
            return;
        }
        try {
            workerDispatcher.dispatchRunCancel(assignee, runId, reason);
            log.info("RUN_CANCEL dispatched runId={} workerId={} reason={}", runId, assignee, reason);
        } catch (Exception e) {
            log.error("RUN_CANCEL dispatch failed runId={} workerId={}", runId, assignee, e);
        }
    }

    // pauseRun / resumeRun 제거 (2026-05-29). Stop + Retry (resume-from-failed-stage) 가
    // 기능 동치이고 paused 의 잠재 버그 4 가지 (CHECK / partial commit / race / 사용자 혼란)
    // 모두 제거됨. project_pause_removed 메모리 참조.

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
        // 단 델타(증분)는 매일 반복 실행 → snapshot 의 execution_context 를 덮어쓰면 그 snapshot 의
        // 대표 run(컷오버/리허설) 컨텍스트가 델타로 오염된다. 델타 이력은 run_history 에 남으므로 skip.
        if (rh.getRunType() != RunType.delta) {
            snapshotExecutionContextService.recordExecutionContext(rh);
        }

        // project.run_status を idle へ戻す (ロック解放)
        Project project = projectRepo.findByIdForUpdate(rh.getProjectId())
                .orElseThrow(() -> new IllegalStateException("project disappeared: " + rh.getProjectId()));
        project.setRunStatus(STATUS_IDLE);

        // rehearsal の場合は last_run_at を更新 (Misfire 判定用)
        if (rh.getRunType() == RunType.rehearsal) {
            project.setScheduleLastRunAt(OffsetDateTime.now());
        }

        // cutover 成功完了 → phase を hypercare へ自動遷移 (one-way).
        // 失敗/abort/timeout の場合は cutover phase に留まり、再試行を許す.
        if (rh.getRunType() == RunType.cutover && finalStatus == RunStatus.success
                && "cutover".equals(project.getPhase())) {
            log.info("Phase auto-advance projectId={} cutover -> hypercare (runId={})",
                    project.getId(), runId);
            project.setPhase("hypercare");
        }

        projectRepo.save(project);

        log.info("finishRun runId={} status={} durationMs={}", runId, finalStatus, durationMs);

        // FE NotificationToast 용 — run 종료 알림. action 으로 success/failed/aborted/timed_out 구별.
        auditLogService.record(project, rh.getRequestedBy() == null ? "system" : rh.getRequestedBy(),
                "run " + finalStatus.name())
                .target(rh.getRunType() == null ? null : rh.getRunType().name())
                .details((rh.getRunType() == null ? "run" : rh.getRunType().name()) + " "
                        + finalStatus.name() + (errorMessage == null ? "" : ": " + errorMessage))
                .save();

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
     * Project phase 로부터 scheduler / 외부 trigger 가 起動해야 할 runType 결정.
     * 스케줄러 (내부 Quartz / 외부 /runs/all / 외부 /runs (runType 省略時)) 가 사용.
     *
     * 設計 (2026-05-29 update): scheduler / 외부 trigger 는 sign-off + ready phase
     * 限定으로 絞る. 이유는 두 phase 모두「snapshot Request Review 가 通過한 後」 =
     * mapping 이 検証済み の状態. 따라서 별도의 preflight DB 영속화 없이도 「FE
     * preflight 通っている前提」 が phase 自体で保証된다.
     *   - sign-off → RunType.rehearsal — mapping approved 後 dry-run.  起動 後
     *                  maybeAdvancePhase 가 phase 를 sign-off → rehearsal 로 自動 前進.
     *   - ready    → RunType.cutover — cutover snapshot approved 後 production 切替.
     *   - 其他 (planning / analysis / test / rehearsal / cutover / hypercare / done)
     *                → empty.  REJECTED 로 결과 표시.  사용자가 UI 에서 explicit runType
     *                指定 하면 /runs 経由로 起動 可能 (= 手動 path 는 制限 없음).
     *
     * 旧 仕様 (default → test) 은 planning / analysis 等 mapping 未準備 의 project 도
     * scheduler 가 fire 시킬 수 있어 사고 リスク 있었다.  본 結束로 「phase eligibility =
     * preflight 통과의 暗黙の保証」 으로 統合.
     */
    public static Optional<RunType> resolveRunTypeFromPhase(String phase) {
        if (phase == null) return Optional.empty();
        return switch (phase) {
            case "sign-off" -> Optional.of(RunType.rehearsal);
            case "ready"    -> Optional.of(RunType.cutover);
            default         -> Optional.empty();
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

    /**
     * Resume-from-failed-run 용 — RunExecutionListener 가 outputDir 결정 직후 호출.
     * 옛 run 의 parquet1 / parquet2 / quarantine 위치를 후속 retry 가 찾을 수 있게 박제.
     */
    @Transactional
    public void recordOutputDir(String runId, String outputDir) {
        RunHistory rh = runHistoryRepo.findById(runId).orElse(null);
        if (rh == null) return;
        Map<String, Object> md = new HashMap<>(rh.getMetadata() == null ? Map.of() : rh.getMetadata());
        md.put("outputDir", outputDir);
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
     *   - rehearsal → 'rehearsal' (sign-off 에서 Run 시 rehearsal 로 진행)
     *   - cutover  → 'cutover'   (ready 에서 Run 시 cutover 로 진행 — 종료 시 finishRun 이 hypercare 로 추가 advance)
     * 데모 모드 FE 가 자체적으로 하던 setProjectPhaseAndRunStatus 의 phase 부분을 BE 로 이관.
     * 참고 선례: DdlImportService.importDdl 의 planning → analysis 자동 전이.
     */
    private void maybeAdvancePhase(Project project, RunType runType) {
        String desired = switch (runType) {
            case test -> "test";
            case rehearsal -> "rehearsal";
            case cutover -> "cutover";
            // 델타는 초기 컷오버 이후 반복 실행 — phase 를 건드리지 않음(현재 phase 유지 → 전진 없음).
            case delta -> project.getPhase();
        };
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
    /**
     * Resume-from-failed-run 정합성 검증 + 재개 시작 stage 결정.
     *
     * 검증 조건 (모두 통과해야 resume 진행, 하나라도 어긋나면 null = 처음부터 fallback):
     *   1. 옛 run 존재.
     *   2. 옛 run.projectId 가 같은 projectId.
     *   3. 옛 run.snapshotId 가 새 run 의 snapshotId 와 동일 (mapping 변경 없음).
     *   4. 옛 run.metadata.selectedTables 가 새 tables 와 같거나 새 tables 가 옛 것의 subset.
     *      (옛 run 의 stage-cache 데이터가 새 tables 를 다 커버하는지 확인.)
     *   5. 옛 run 에 success 인 stage 가 1개 이상 (skip 할 게 있어야 의미 있음).
     *
     * @return 재개 시작 stage key (= 옛 run 의 첫 비-success stage). 그 stage 부터 실행.
     *         또는 null (검증 실패 → 처음부터). 옛 run 이 모두 success 면 null (재실행 의미 없음).
     */
    private String validateResumeContext(String resumeFromRunId, String projectId,
                                         String snapshotId, List<String> newTables) {
        RunHistory old = runHistoryRepo.findById(resumeFromRunId).orElse(null);
        if (old == null) {
            log.info("resume: old run not found id={}", resumeFromRunId);
            return null;
        }
        if (!projectId.equals(old.getProjectId())) {
            log.info("resume: old run project mismatch old={} new={}", old.getProjectId(), projectId);
            return null;
        }
        // snapshotId 비교 — 양쪽 모두 null 인 경우 OK, 한쪽만 null 이거나 다른 값이면 mapping 변경.
        String oldSnap = old.getSnapshotId();
        if (oldSnap == null ? snapshotId != null : !oldSnap.equals(snapshotId)) {
            log.info("resume: snapshot mismatch old={} new={} — mapping changed", oldSnap, snapshotId);
            return null;
        }
        // selectedTables — 새 tables 가 옛 tables 의 subset 인지.
        @SuppressWarnings("unchecked")
        List<String> oldTables = old.getMetadata() == null ? null
                : (List<String>) old.getMetadata().get("selectedTables");
        if (newTables != null && !newTables.isEmpty()) {
            if (oldTables == null) {
                // 옛 run 은 전체였고 새 run 도 일부 — 옛 데이터로 충분히 커버. OK.
            } else if (!oldTables.containsAll(newTables)) {
                log.info("resume: new tables {} not subset of old {} — extra tables not cached", newTables, oldTables);
                return null;
            }
        }
        // 옛 run 의 stage 들 순회 — 첫 비-success stage 가 재개 시작점.
        List<StageInstance> oldStages = stageInstanceRepo.findByRunIdOrderBySeqAsc(resumeFromRunId);
        for (StageInstance s : oldStages) {
            if (s.getStatus() != StageStatus.success) {
                return s.getStageKey();
            }
        }
        // 모두 success — 재실행 의미 없음.
        log.info("resume: all stages of {} are success — nothing to resume", resumeFromRunId);
        return null;
    }

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
            // 델타는 컷오버와 동일한 승인 매핑으로 변환해야 하므로 cutover snapshot 을 재사용.
            // 없으면 null 허용(bindings 는 라이브에 존재 — cutover 처럼 필수는 아님).
            case delta -> snapshotRepo.findLatestApprovedByProjectIdAndType(projectId, "cutover")
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

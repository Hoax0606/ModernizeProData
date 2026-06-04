package com.ksinfo.modernize_pro_data.coordinator.worker;

import com.ksinfo.modernize_pro_data.coordinator.run.RunControlRegistry;
import com.ksinfo.modernize_pro_data.coordinator.run.RunType;
import com.ksinfo.modernize_pro_data.coordinator.run.stage.StageInstance;
import com.ksinfo.modernize_pro_data.coordinator.run.stage.StageInstanceRepository;
import com.ksinfo.modernize_pro_data.coordinator.run.stage.StageStatus;
import com.ksinfo.modernize_pro_data.coordinator.run.stage.StageTableResult;
import com.ksinfo.modernize_pro_data.coordinator.run.stage.StageTableResultRepository;
import com.ksinfo.modernize_pro_data.coordinator.run.stage.StageTableStatus;
import jakarta.annotation.PostConstruct;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

import java.time.OffsetDateTime;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

/**
 * In-process sequential stage 실행기. PoC 1차 default.
 *
 * Spring 이 모든 StageRunner @Service bean 을 autowire 하고, stageKey() 로 registry 구성.
 * RunService.startRun 끝에 호출.
 *
 * 에러 모델 = continue-on-error (모든 runType 공통):
 *   - 단계 안에서는 테이블별 try/catch — 일부 실패해도 나머지 처리.
 *   - 단계 사이에는 throw(구조적 실패) 시에만 downstream skip — 다음 stage 가 깨진 input 위에서 돌아 cascade 오염되는 것 방지.
 *   - **이전 분리되었던 cutover strict gate (stage 실패 → downstream skip) 는 제거 (2026-05-29).**
 *     이유: 첫 배포 현장이 green-field (빈 DB 채우고 swap-out) 모델 — 부분 실패해도 옛 DB 가 살아있어 rollback 비용 거의 0.
 *     "한 번에 모든 실패 발견 → 한 번에 fix" 의 시연 효율이 strict 보호보다 가치. live-swap (in-place 갱신)
 *     현장이 추후 필요하면 site-level 정책(`cutover_policy`)으로 재도입. 자세한 근거는 docs/ONBOARDING.md §"Cutover gate policy".
 *   - 게이트 발동 시 IllegalStateException 으로 run 을 failed 처리 (RunExecutionListener catch).
 */
@Service
@RequiredArgsConstructor
@Slf4j
public class LocalWorkerExecutor implements WorkerExecutor {

    /* NON_BLOCKING_STAGES 제거 (2026-05-30, V-7 분리 정책 → 합병 정책 전환).
     * Validation stage 도 다른 stage 와 동일 취급 — fail 시 run.status=failed.
     * Validation issue 도 quarantine entry 발생 (ValidationReportService 내부). */

    private final List<StageRunner> stageRunners;
    private final RunControlRegistry runControlRegistry;
    private final StageProgressBroadcaster broadcaster;
    private final StageInstanceRepository stageInstanceRepo;
    private final StageTableResultRepository stageTableResultRepo;

    private Map<String, StageRunner> registry;

    @PostConstruct
    void init() {
        registry = stageRunners.stream()
                .collect(Collectors.toMap(StageRunner::stageKey, r -> r));
        log.info("LocalWorkerExecutor initialized with stage runners: {}", registry.keySet());
    }

    @Override
    public void execute(StageContext ctx) {
        String runId = ctx.getRunHistory().getId();
        // cutover-specific strict gate 는 2026-05-29 에 제거됨 — green-field 모델에선 over-protective.
        // 로깅 용도로 runType 만 유지 (gate 로직엔 안 씀).
        RunType runType = ctx.getRunHistory().getRunType();
        log.info("Run execution started runId={} runType={} stages={}",
                runId, runType,
                ctx.getStages().stream().map(StageInstance::getStageKey).toList());

        String gateReason = null;
        boolean runCancelled = false;   // for-loop 빠져나간 후 final check 에서 cancel 인지 판별 (cancel 이면 IllegalStateException 안 던짐).
        for (StageInstance stage : ctx.getStages()) {
            // stage-cache 로 이미 완료 처리된 stage(extract/reconcile/transform) 는 skip.
            if (stage.getStatus() == StageStatus.success) {
                log.info("Stage '{}' already done (stage-cache) — skip runId={}", stage.getStageKey(), runId);
                continue;
            }
            // abort/timeout 으로 cancel 되면 이후 stage 중단 (stage 경계 반응).
            if (runControlRegistry.isCancelled(runId)) {
                log.warn("Run cancelled — stopping before stage '{}' runId={}", stage.getStageKey(), runId);
                runCancelled = true;
                break;
            }
            StageRunner runner = registry.get(stage.getStageKey());
            if (runner == null) {
                log.warn("No StageRunner registered for stageKey={}, skipping", stage.getStageKey());
                continue;
            }
            /* Stage 시작 broadcast — runner 가 setStatus(running) save 하기 직전 한 번 더
               알려 줘서 FE 가 stage marker 를 즉시 진행으로 표시. payload status 는 아직
               pending 일 수 있지만 invalidate trigger 만 필요. */
            broadcaster.stageLifecycle(runId, stage, false);
            boolean threw = false;
            boolean cancelled = false;
            try {
                runner.run(ctx, stage);
            } catch (RunCancelledException ce) {
                /* (A) 정공법 — stage runner 가 ctx.throwIfCancelled() 로 정지 신호 잡았음.
                   현재 stage 는 미완료 상태로 abort 됐으므로 failed 로 마킹.
                   사용자 보고 "정지 누른 단계는 원래 fail 이었는데 지금 pass 로 표시" 해소.
                   downstream stages 는 pending 유지 (실행 안 함). */
                cancelled = true;
                stage.setStatus(StageStatus.failed);
                stage.setFinishedAt(OffsetDateTime.now());
                stage.setErrorSummary("aborted by user/timeout");
                stageInstanceRepo.save(stage);
                log.warn("Stage '{}' cancelled — marked failed runId={}", stage.getStageKey(), runId);
            } catch (Exception e) {
                threw = true;
                log.error("StageRunner {} threw", stage.getStageKey(), e);
            }
            /* (B) 방어선 — stage runner 가 cancel 체크를 빠뜨려서 정상 return 한 경우라도,
               그 사이에 cancel 신호가 set 됐다면 사용자 의도는 abort 이므로 stage 를 failed 로 강제 표시.
               (A) 의 throwIfCancelled() 호출이 누락된 stage 에 대한 안전망. */
            if (!cancelled && !threw && runControlRegistry.isCancelled(runId)
                    && stage.getStatus() == StageStatus.success) {
                stage.setStatus(StageStatus.failed);
                stage.setErrorSummary("aborted by user/timeout (stage completed after cancel signal)");
                stageInstanceRepo.save(stage);
                cancelled = true;
                log.warn("Stage '{}' completed but cancel was signaled — marked failed runId={}",
                        stage.getStageKey(), runId);
            }
            /* 실시간 진행 알림 — FE 의 /topic/run/{id}/progress 구독자가 invalidate 한다.
               옵션 채널 — STOMP 끊겨도 FE 의 polling(2s)이 fallback. */
            broadcaster.stageLifecycle(runId, stage, threw || cancelled);
            // 게이트 (단계 사이): 구조적 실패(throw)에서만 downstream 중단.
            // 이전엔 cutover 도 stage 실패(tables_failed>0) 시 추가로 게이트 발동했으나 2026-05-29 제거.
            // 근거: green-field 배포 모델에선 strict 의 보호 가치 < "한 번에 모두 발견" 효율.
            if (cancelled) {
                // (E) 방어선 — running 상태로 남은 stage_table_results 도 failed 로 마킹.
                // (D) sub-step cancel 체크가 잡으면 그 시점의 binding 의 result 가 running 상태 →
                // 운영자 화면에서 "정지 잡힌 binding 도 fail 표시" 가 audit 정확.
                markRunningTableResultsFailed(stage, "aborted by user/timeout");
                runCancelled = true;   // final check 에서 IllegalStateException skip 하기 위함.
                // cancel 은 사용자 의도된 중단 — IllegalStateException throw 안 함 (RunService.abortRun 이 이미 finishRun 호출).
                // 단 downstream 은 실행 안 함 (다음 stage 진입 시 isCancelled 가드가 잡음).
                log.info("Run cancelled at stage '{}' — downstream skipped runId={}", stage.getStageKey(), runId);
                break;
            }
            if (threw) {
                gateReason = "gated at stage '" + stage.getStageKey() + "' (threw) — downstream stages skipped";
                log.warn("Run gate triggered runId={}: {}", runId, gateReason);
                break;
            }
        }

        log.info("Run execution finished runId={} gated={} cancelled={}", runId, gateReason != null, runCancelled);
        if (gateReason != null) {
            // 게이트 → run 을 failed 로 (listener 의 catch 가 failRun). 남은 stage 는 pending 유지(미실행).
            throw new IllegalStateException(gateReason);
        }
        // cancel 로 인한 중단 — 사용자/timeout 의도된 정지. RunService.abortRun 이 이미 run.status=aborted 로
        // finishRun 처리했음. 여기서 IllegalStateException 던지면 listener 가 ERROR 로깅 + failRun 시도
        // (finishRun 의 isTerminal 가드로 no-op 이긴 하나 spurious ERROR 로그 발생).
        // 그래서 cancel 인 경우엔 정상 return.
        if (runCancelled) {
            log.info("Run cancelled — finishing execute() without throwing runId={}", runId);
            return;
        }
        // 게이트 안 났어도 어떤 stage 라도 failed 면 run 도 failed (모든 stage success 일 때만 run.status=success).
        // continue-on-error 로 luna 통과해도 결과를 사용자에게 정확히 알려야 함 — 화면 "COMPLETED" 인데 실제는 0건 적재 같은 혼동 방지.
        // 2026-05-30: validation 도 다른 stage 와 동일 취급 (NON_BLOCKING_STAGES 화이트리스트 제거).
        long failedStages = ctx.getStages().stream()
                .filter(s -> s.getStatus() == StageStatus.failed)
                .count();
        if (failedStages > 0) {
            String reason = failedStages + " stage(s) failed during run";
            log.warn("Run finished with failed stages runId={}: {}", runId, reason);
            throw new IllegalStateException(reason);
        }
    }

    /**
     * cancel 영향 받은 stage 의 stage_table_results 중 running 상태인 것을 failed 로 강제 마킹.
     * (D) sub-step cancel 체크가 binding 처리 *중간* 에 잡으면 그 binding 의 result 는
     * running 상태 (lazy insert 후 success 마킹 전). 운영자 화면에서 그 binding 도 fail 로
     * 표시되어야 stop 의도와 일관 → 이 메서드가 정리.
     *
     * 이미 success/failed 로 마킹된 result 는 안 만짐 — 실제 처리 끝난 binding 의 audit 데이터 보존.
     */
    private void markRunningTableResultsFailed(StageInstance stage, String reason) {
        List<StageTableResult> results = stageTableResultRepo.findByStageInstanceId(stage.getId());
        OffsetDateTime now = OffsetDateTime.now();
        int marked = 0;
        for (StageTableResult r : results) {
            if (r.getStatus() == StageTableStatus.running) {
                r.setStatus(StageTableStatus.failed);
                r.setFinishedAt(now);
                r.setErrorDetail(Map.of("reason", reason));
                stageTableResultRepo.save(r);
                marked++;
            }
        }
        if (marked > 0) {
            log.warn("Marked {} running stage_table_results as failed (reason={}) stageId={}",
                    marked, reason, stage.getId());
        }
    }

}

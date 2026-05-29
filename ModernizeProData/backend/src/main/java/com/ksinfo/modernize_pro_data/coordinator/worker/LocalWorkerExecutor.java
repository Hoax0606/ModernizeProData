package com.ksinfo.modernize_pro_data.coordinator.worker;

import com.ksinfo.modernize_pro_data.coordinator.run.RunControlRegistry;
import com.ksinfo.modernize_pro_data.coordinator.run.RunType;
import com.ksinfo.modernize_pro_data.coordinator.run.stage.StageInstance;
import com.ksinfo.modernize_pro_data.coordinator.run.stage.StageStatus;
import jakarta.annotation.PostConstruct;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.messaging.simp.SimpMessagingTemplate;
import org.springframework.stereotype.Service;

import java.util.HashMap;
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

    private final List<StageRunner> stageRunners;
    private final RunControlRegistry runControlRegistry;
    private final SimpMessagingTemplate stomp;

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
        for (StageInstance stage : ctx.getStages()) {
            // stage-cache 로 이미 완료 처리된 stage(extract/reconcile/transform) 는 skip.
            if (stage.getStatus() == StageStatus.success) {
                log.info("Stage '{}' already done (stage-cache) — skip runId={}", stage.getStageKey(), runId);
                continue;
            }
            // abort/timeout 으로 cancel 되면 이후 stage 중단 (stage 경계 반응).
            if (runControlRegistry.isCancelled(runId)) {
                log.warn("Run cancelled — stopping before stage '{}' runId={}", stage.getStageKey(), runId);
                break;
            }
            StageRunner runner = registry.get(stage.getStageKey());
            if (runner == null) {
                log.warn("No StageRunner registered for stageKey={}, skipping", stage.getStageKey());
                continue;
            }
            boolean threw = false;
            try {
                runner.run(ctx, stage);
            } catch (Exception e) {
                threw = true;
                log.error("StageRunner {} threw", stage.getStageKey(), e);
            }
            /* 실시간 진행 알림 — FE 의 /topic/run/{id}/progress 구독자가 invalidate 한다.
               옵션 채널 — STOMP 끊겨도 FE 의 polling(2s)이 fallback. */
            broadcastStage(runId, stage, threw);
            // 게이트 (단계 사이): 구조적 실패(throw)에서만 downstream 중단.
            // 이전엔 cutover 도 stage 실패(tables_failed>0) 시 추가로 게이트 발동했으나 2026-05-29 제거.
            // 근거: green-field 배포 모델에선 strict 의 보호 가치 < "한 번에 모두 발견" 효율.
            if (threw) {
                gateReason = "gated at stage '" + stage.getStageKey() + "' (threw) — downstream stages skipped";
                log.warn("Run gate triggered runId={}: {}", runId, gateReason);
                break;
            }
        }

        log.info("Run execution finished runId={} gated={}", runId, gateReason != null);
        if (gateReason != null) {
            // 게이트 → run 을 failed 로 (listener 의 catch 가 failRun). 남은 stage 는 pending 유지(미실행).
            throw new IllegalStateException(gateReason);
        }
        // 게이트 안 났어도 어떤 stage 라도 failed 면 run 도 failed (모든 stage success 일 때만 run.status=success).
        // continue-on-error 로 luna 통과해도 결과를 사용자에게 정확히 알려야 함 — 화면 "COMPLETED" 인데 실제는 0건 적재 같은 혼동 방지.
        long failedStages = ctx.getStages().stream()
                .filter(s -> s.getStatus() == StageStatus.failed)
                .count();
        if (failedStages > 0) {
            String reason = failedStages + " stage(s) failed during run";
            log.warn("Run finished with failed stages runId={}: {}", runId, reason);
            throw new IllegalStateException(reason);
        }
    }

    /** Stage 완료(or throw) 후 한 줄 알림. payload 는 FE 가 invalidate 트리거로만 사용 가능. */
    private void broadcastStage(String runId, StageInstance stage, boolean threw) {
        try {
            Map<String, Object> payload = new HashMap<>();
            payload.put("type", "stage");
            payload.put("stageKey", stage.getStageKey());
            payload.put("status", threw ? "failed"
                    : stage.getStatus() == null ? "unknown" : stage.getStatus().name());
            payload.put("success", stage.getTablesSuccess() == null ? 0 : stage.getTablesSuccess());
            payload.put("failed", stage.getTablesFailed() == null ? 0 : stage.getTablesFailed());
            stomp.convertAndSend("/topic/run/" + runId + "/progress", payload);
        } catch (Exception e) {
            log.debug("Stage broadcast failed runId={} stage={}: {}",
                    runId, stage.getStageKey(), e.getMessage());
        }
    }
}

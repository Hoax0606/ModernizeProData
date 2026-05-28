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
 * 에러 모델 = 하이브리드:
 *   - 단계 안에서는 continue-on-error (각 stage 가 테이블별 try/catch 로 일부 실패해도 나머지 처리).
 *   - 단계 사이엔 게이트: stage 가 throw(구조적 실패) 하면 항상 downstream skip;
 *     cutover 면 stage 실패(tables_failed>0)도 downstream skip (본운영에 깨진 데이터 방지).
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
        boolean isCutover = ctx.getRunHistory().getRunType() == RunType.cutover;
        log.info("Run execution started runId={} cutover={} stages={}",
                runId, isCutover,
                ctx.getStages().stream().map(StageInstance::getStageKey).toList());

        String gateReason = null;
        for (StageInstance stage : ctx.getStages()) {
            // stage-cache 로 이미 완료 처리된 stage(extract/reconcile/transform) 는 skip.
            if (stage.getStatus() == StageStatus.success) {
                log.info("Stage '{}' already done (stage-cache) — skip runId={}", stage.getStageKey(), runId);
                continue;
            }
            // 일시정지 대기 (stage 경계). abort/timeout 으로 cancel 되면 이후 stage 중단.
            runControlRegistry.awaitWhilePaused(runId);
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
            // 하이브리드 게이트 (단계 사이): 구조적 실패(throw)면 항상, cutover 면 stage 실패도 downstream 중단.
            boolean stageFailed = threw || stage.getStatus() == StageStatus.failed;
            if (threw || (isCutover && stageFailed)) {
                gateReason = "gated at stage '" + stage.getStageKey() + "' ("
                        + (threw ? "threw" : "failed") + ") — downstream stages skipped";
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

package com.ksinfo.modernize_pro_data.coordinator.worker;

import com.ksinfo.modernize_pro_data.coordinator.run.stage.StageInstance;
import com.ksinfo.modernize_pro_data.coordinator.run.stage.StageStatus;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.ApplicationContext;
import org.springframework.messaging.simp.SimpMessagingTemplate;
import org.springframework.stereotype.Service;

import java.util.HashMap;
import java.util.Map;

/**
 * Stage 진행 신호를 FE 로 전달하는 단일 진입점.
 *
 * - Coordinator self mode = local STOMP broker 로 직접 publish
 *   ({@code /topic/run/{runId}/progress}).
 * - Worker mode = Coordinator 의 internal REST endpoint
 *   ({@code POST /api/v1/internal/runs/{runId}/stage}) 로 forward — Coordinator 가
 *   받아서 자체 broker 로 re-broadcast. Worker 자체 broker(:8081) 에 publish 하면
 *   FE 가 못 받음.
 *
 * Stage runner 가 부드러운 progress 갱신을 원하면 table 한 건 끝날 때마다
 * {@link #stageProgress} 를 호출. payload 는 FE 에서 invalidate trigger 로만
 * 사용되므로 정확한 row count 보다 변경 빈도가 중요.
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class StageProgressBroadcaster {

    private final SimpMessagingTemplate stomp;
    /** WorkerBootstrap 의 HTTP client 재사용 — circular dep 회피 위해 lazy lookup. */
    private final ApplicationContext appContext;

    @Value("${modernize.mode:coordinator}")
    private String mode;

    /** Stage 가 시작되거나 끝났을 때 호출 — payload status = running / success / failed / unknown. */
    public void stageLifecycle(String runId, StageInstance stage, boolean threw) {
        Map<String, Object> payload = basePayload(stage);
        payload.put("type", "stage");
        payload.put("status", threw ? "failed"
                : stage.getStatus() == null ? "unknown" : stage.getStatus().name());
        send(runId, payload);
    }

    /**
     * Table 한 건 완료 시 호출 — stage 의 진행률이 갱신됐음을 알린다. polling 데이터
     * 갱신을 trigger 할 뿐 payload 자체로 progress 를 그리지 않으므로 throttling
     * 정책 (예: 5건마다) 은 caller 책임.
     */
    public void stageProgress(String runId, StageInstance stage) {
        Map<String, Object> payload = basePayload(stage);
        payload.put("type", "stage-progress");
        payload.put("status", stage.getStatus() == null ? "running" : stage.getStatus().name());
        send(runId, payload);
    }

    private Map<String, Object> basePayload(StageInstance stage) {
        Map<String, Object> p = new HashMap<>();
        p.put("stageKey", stage.getStageKey());
        p.put("success", stage.getTablesSuccess() == null ? 0 : stage.getTablesSuccess());
        p.put("failed",  stage.getTablesFailed()  == null ? 0 : stage.getTablesFailed());
        p.put("total",   stage.getTablesTotal()   == null ? 0 : stage.getTablesTotal());
        return p;
    }

    private void send(String runId, Map<String, Object> payload) {
        if ("worker".equals(mode)) {
            try {
                appContext.getBean(WorkerBootstrap.class).postStageProgress(runId, payload);
            } catch (Exception e) {
                log.debug("Stage broadcast (worker→coord) failed runId={}: {}",
                        runId, e.getMessage());
            }
        } else {
            try {
                stomp.convertAndSend("/topic/run/" + runId + "/progress", payload);
            } catch (Exception e) {
                log.debug("Stage broadcast (local STOMP) failed runId={}: {}",
                        runId, e.getMessage());
            }
        }
    }
}

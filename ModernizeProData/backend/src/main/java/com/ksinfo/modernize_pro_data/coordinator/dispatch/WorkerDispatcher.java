package com.ksinfo.modernize_pro_data.coordinator.dispatch;

import com.ksinfo.modernize_pro_data.coordinator.run.RunHistory;
import lombok.RequiredArgsConstructor;
import org.springframework.messaging.simp.SimpMessagingTemplate;
import org.springframework.stereotype.Component;

import java.time.OffsetDateTime;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;

/**
 * Coordinator → Worker 의 WS push dispatcher.
 *
 * Worker 専用 STOMP 토픽 ({@code /topic/worker/{workerId}/tasks}) 으로
 * RUN_START / RUN_CANCEL / PING envelope 을 publish.
 *
 * PoC 1 次 시점에서는 단일 Worker 전제로 {@code workerId = "default"} 하드코드.
 * 멀티 Worker 화는 worker_nodes 테이블 추가 (別 branch) 이후.
 */
@Component
@RequiredArgsConstructor
public class WorkerDispatcher {

    /** PoC 시점의 단일 Worker ID. worker_nodes 도입 시 動的 selection に置換. */
    public static final String DEFAULT_WORKER_ID = "default";

    private final SimpMessagingTemplate messagingTemplate;

    /**
     * RUN_START envelope を Worker トピックに publish.
     *
     * Worker は受信後 {@code GET /api/v1/internal/runs/{runId}/payload} で詳細 fetch.
     */
    public void dispatchRunStart(RunHistory rh) {
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("runId", rh.getId());
        payload.put("projectId", rh.getProjectId());
        payload.put("runType", rh.getRunType().name());
        payload.put("triggerSource", rh.getTriggerSource().name());

        send("RUN_START", payload);
    }

    /**
     * RUN_CANCEL envelope を publish.
     *
     * @param reason "user_aborted" / "timed_out" / "system_shutdown" 等
     */
    public void dispatchRunCancel(String runId, String reason) {
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("runId", runId);
        payload.put("reason", reason);

        send("RUN_CANCEL", payload);
    }

    /** PING — Coordinator 生存通知 (Worker heartbeat 의 逆方向). 任意. */
    public void dispatchPing() {
        send("PING", Map.of());
    }

    private void send(String type, Map<String, Object> payload) {
        Map<String, Object> envelope = new LinkedHashMap<>();
        envelope.put("messageId", "msg-" + UUID.randomUUID().toString().substring(0, 8));
        envelope.put("timestamp", OffsetDateTime.now().toString());
        envelope.put("type", type);
        envelope.put("payload", payload);

        String destination = "/topic/worker/" + DEFAULT_WORKER_ID + "/tasks";
        messagingTemplate.convertAndSend(destination, envelope);
    }
}

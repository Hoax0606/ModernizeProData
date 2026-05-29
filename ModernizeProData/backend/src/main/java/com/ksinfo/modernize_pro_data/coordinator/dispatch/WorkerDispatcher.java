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

    /** Worker username 미할당시 (assignee 없는 ad-hoc run 등) 사용하는 fallback workerId. */
    public static final String DEFAULT_WORKER_ID = "default";

    private final SimpMessagingTemplate messagingTemplate;

    /**
     * RUN_START envelope 을 assigned worker 의 토픽에 publish.
     * rh.workerId 가 username (executionAssignee) 이고, destination 도 그 username 으로 라우팅.
     */
    public void dispatchRunStart(RunHistory rh) {
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("runId", rh.getId());
        payload.put("projectId", rh.getProjectId());
        payload.put("runType", rh.getRunType().name());
        payload.put("triggerSource", rh.getTriggerSource().name());
        send(rh.getWorkerId(), "RUN_START", payload);
    }

    /** RUN_CANCEL — 그 run 을 발사했던 worker 로 보낸다 (workerId 인자 명시). */
    public void dispatchRunCancel(String workerId, String runId, String reason) {
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("runId", runId);
        payload.put("reason", reason);
        send(workerId, "RUN_CANCEL", payload);
    }

    /** PING — Coordinator 생존 통지 (Worker heartbeat 의 역방향). 任意. */
    public void dispatchPing(String workerId) {
        send(workerId, "PING", Map.of());
    }

    private void send(String workerId, String type, Map<String, Object> payload) {
        Map<String, Object> envelope = new LinkedHashMap<>();
        envelope.put("messageId", "msg-" + UUID.randomUUID().toString().substring(0, 8));
        envelope.put("timestamp", OffsetDateTime.now().toString());
        envelope.put("type", type);
        envelope.put("payload", payload);

        String dest = (workerId == null || workerId.isBlank()) ? DEFAULT_WORKER_ID : workerId;
        messagingTemplate.convertAndSend("/topic/worker/" + dest + "/tasks", envelope);
    }
}

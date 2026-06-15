package com.ksinfo.modernize_pro_data.coordinator.worker;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.ksinfo.modernize_pro_data.coordinator.run.RunControlRegistry;
import com.ksinfo.modernize_pro_data.coordinator.run.RunExecutionListener;
import jakarta.annotation.PostConstruct;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.messaging.converter.MappingJackson2MessageConverter;
import org.springframework.messaging.simp.stomp.StompCommand;
import org.springframework.messaging.simp.stomp.StompFrameHandler;
import org.springframework.messaging.simp.stomp.StompHeaders;
import org.springframework.messaging.simp.stomp.StompSession;
import org.springframework.messaging.simp.stomp.StompSessionHandlerAdapter;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.WebSocketHttpHeaders;
import org.springframework.web.socket.client.standard.StandardWebSocketClient;
import org.springframework.web.socket.messaging.WebSocketStompClient;

import java.lang.reflect.Type;
import java.net.InetAddress;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.time.OffsetDateTime;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Worker mode daemon (login-based model).
 *
 * <p>When this Coordinator image is actually deployed as a Worker
 * (modernize.mode=worker) it does NOT serve as a Coordinator -- it logs in to
 * a remote Coordinator and registers itself as a worker_node:
 *
 * <ol>
 *   <li>POST {coordinatorUrl}/api/v1/auth/login with the admin user's
 *       username + password configured at installer time. Cache the JWT.</li>
 *   <li>POST /api/v1/workers/self-register with the JWT and this PC's
 *       hostname. The Coordinator creates or refreshes the worker_node row
 *       tied to that user + hostname.</li>
 *   <li>Every 60s, POST /api/v1/workers/heartbeat with the same JWT. If the
 *       call fails 401/expired, re-login and try again.</li>
 * </ol>
 */
@Slf4j
@Component
public class WorkerBootstrap {

    @Value("${modernize.mode:coordinator}")
    private String mode;

    @Value("${modernize.coordinator.url:}")
    private String coordinatorUrl;

    @Value("${modernize.worker.username:}")
    private String workerUsername;

    @Value("${modernize.worker.password:}")
    private String workerPassword;

    /** 설치 앱 버전 — 빌드가 -Dmodernize.version 으로 주입 (개발 실행 시 'dev').
     *  self-register / heartbeat 시 Coordinator 에 보고해 User Management 에서 표시. */
    @Value("${modernize.version:dev}")
    private String appVersion;

    private final HttpClient http = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(5))
            .build();
    private final ObjectMapper mapper = new ObjectMapper();

    private final AtomicReference<String> jwt = new AtomicReference<>(null);
    private final AtomicReference<Status> status = new AtomicReference<>(Status.idle());
    /** STOMP 한 번만 연결 — register 가 retry 돌아도 중복 connect 안 함. */
    private final AtomicBoolean stompConnected = new AtomicBoolean(false);

    /** Run dispatch 핸들러 — Coordinator → Worker WS push 받았을 때 호출. */
    @Autowired
    private RunExecutionListener runExecutionListener;

    /** RUN_CANCEL 수신 시 worker process 의 stage runner 를 깨우기 위해 사용. */
    @Autowired
    private RunControlRegistry runControlRegistry;

    /** worker 동시 실행 상한 산정 (RAM/CPU 기반). 초과 run 은 큐 대기. */
    @Autowired
    private com.ksinfo.modernize_pro_data.common.config.RunCapacityPlanner capacityPlanner;

    /** worker 측 run 실행 풀 — maxConcurrent 만 동시 실행, 나머지는 큐. 이전엔 run 마다 raw thread
     *  를 만들어 상한이 없었다(배정된 만큼 전부 동시 → 메모리 폭발). lazy 초기화. */
    private volatile java.util.concurrent.ExecutorService runPool;

    private java.util.concurrent.ExecutorService runPool() {
        java.util.concurrent.ExecutorService p = runPool;
        if (p == null) {
            synchronized (this) {
                p = runPool;
                if (p == null) {
                    int n = Math.max(1, capacityPlanner.getMaxConcurrent());
                    java.util.concurrent.atomic.AtomicInteger seq = new java.util.concurrent.atomic.AtomicInteger();
                    p = new java.util.concurrent.ThreadPoolExecutor(
                            n, n, 0L, java.util.concurrent.TimeUnit.MILLISECONDS,
                            new java.util.concurrent.LinkedBlockingQueue<>(),
                            r -> { Thread t = new Thread(r, "worker-run-" + seq.incrementAndGet()); t.setDaemon(true); return t; });
                    runPool = p;
                    log.info("Worker run pool created: maxConcurrent={} (자원 기반, 초과분 큐 대기)", n);
                }
            }
        }
        return p;
    }

    public record Status(
            String coordinatorUrl,
            String username,
            String workerId,
            String state,            // "idle" | "registered" | "error" | "disabled"
            OffsetDateTime lastBeatAt,
            String lastError
    ) {
        static Status idle() { return new Status(null, null, null, "idle", null, null); }
    }

    public Status snapshot() { return status.get(); }
    public boolean isWorkerMode() { return "worker".equalsIgnoreCase(mode); }

    @PostConstruct
    void announce() {
        if (!isWorkerMode()) return;
        if (!hasConfig()) {
            log.warn("Worker mode but Coordinator URL / username / password missing — daemon disabled.");
            status.set(new Status(coordinatorUrl, workerUsername, null, "disabled", null,
                    "Coordinator URL, username, or password not set"));
            return;
        }
        log.info("Worker mode: will log in to {} as {} on startup.", coordinatorUrl, workerUsername);
    }

    @EventListener(ApplicationReadyEvent.class)
    void registerOnReady() {
        if (!hasConfig()) return;
        if (!ensureLoggedIn()) return;
        selfRegister();
    }

    @Scheduled(fixedDelay = 60_000L, initialDelay = 60_000L)
    void heartbeat() {
        if (!hasConfig()) return;
        if (jwt.get() == null && !ensureLoggedIn()) return;
        try {
            JsonNode body = postJson("/api/v1/workers/heartbeat",
                    "{\"hostname\":\"" + escape(hostname()) + "\",\"appVersion\":\"" + escape(appVersion) + "\"}");
            // 401 일 때 ensureLoggedIn() 가 재로그인 + self-register 도 다시.
            updateStatus("registered", body.path("data").path("workerId").asText(currentWorkerId()), null);
        } catch (Unauthorized ignored) {
            log.info("JWT expired — re-logging in.");
            jwt.set(null);
            if (ensureLoggedIn()) selfRegister();
        } catch (Exception e) {
            updateStatus("error", currentWorkerId(), e.getMessage());
            log.debug("Heartbeat to {} failed: {}", coordinatorUrl, e.getMessage());
        }
    }

    private boolean hasConfig() {
        return isWorkerMode()
                && !coordinatorUrl.isBlank()
                && !workerUsername.isBlank()
                && !workerPassword.isBlank();
    }

    private boolean ensureLoggedIn() {
        if (jwt.get() != null) return true;
        // wizard 가 이미 발급받은 token 재사용 — backend 의 자체 login 이 UI 의 wizard
        // session 을 evict 해 Edge UI 가 401 → reload → process exit cycle 회피.
        // expire / invalidate 시 fallback 으로 user/pass 자체 login.
        String bootstrapJwt = System.getProperty("WORKER_BOOTSTRAP_JWT");
        if (bootstrapJwt != null && !bootstrapJwt.isBlank()) {
            jwt.set(bootstrapJwt);
            System.clearProperty("WORKER_BOOTSTRAP_JWT");
            log.info("Reusing wizard JWT — sharing session with Worker UI.");
            return true;
        }
        try {
            String body = "{\"username\":\"" + escape(workerUsername) + "\","
                        + "\"password\":\"" + escape(workerPassword) + "\"}";
            JsonNode res = postJson("/api/v1/auth/login", body, /*authed=*/false);
            String token = res.path("data").path("token").asText(null);
            if (token == null || token.isBlank()) {
                throw new RuntimeException("login response missing token");
            }
            jwt.set(token);
            log.info("Logged in to Coordinator as {}.", workerUsername);
            return true;
        } catch (Exception e) {
            log.warn("Coordinator login failed ({}): {}", workerUsername, e.getMessage());
            updateStatus("error", null, e.getMessage());
            return false;
        }
    }

    private void selfRegister() {
        try {
            JsonNode body = postJson("/api/v1/workers/self-register",
                    "{\"hostname\":\"" + escape(hostname()) + "\",\"appVersion\":\"" + escape(appVersion) + "\"}");
            String workerId = body.path("data").path("workerId").asText(null);
            updateStatus("registered", workerId, null);
            log.info("Self-registered as workerId={}", workerId);
            // STOMP 연결은 self-register 이후에 한 번만 — Coordinator 가 같은 username 의
            // /topic/worker/{username}/tasks 채널로 RUN_START 를 push 하면 이 Worker 가 받아
            // 자기 backend 의 RunExecutionListener.executeRun() 으로 그 run 을 처리한다.
            if (stompConnected.compareAndSet(false, true)) {
                connectStomp();
            }
        } catch (Unauthorized e) {
            jwt.set(null);
            updateStatus("error", currentWorkerId(), "session expired during register");
        } catch (Exception e) {
            updateStatus("error", currentWorkerId(), e.getMessage());
            log.warn("Self-register failed: {}", e.getMessage());
        }
    }

    private void updateStatus(String state, String workerId, String err) {
        status.set(new Status(coordinatorUrl, workerUsername, workerId, state,
                OffsetDateTime.now(), err));
    }

    private String currentWorkerId() {
        Status s = status.get();
        return s == null ? null : s.workerId();
    }

    private String hostname() {
        try { return InetAddress.getLocalHost().getHostName(); }
        catch (Exception e) { return "unknown-host"; }
    }

    private JsonNode postJson(String path, String jsonBody) throws Exception {
        return postJson(path, jsonBody, true);
    }

    /**
     * Stage progress broadcast — Worker mode 에서 LocalWorkerExecutor 가 호출.
     * Coordinator 의 /api/v1/internal/runs/{runId}/stage 가 받아 FE 의
     * /topic/run/{runId}/progress 로 re-broadcast 한다. fail = silent (FE polling fallback).
     */
    public void postStageProgress(String runId, java.util.Map<String, Object> payload) {
        try {
            String body = mapper.writeValueAsString(payload);
            postJson("/api/v1/internal/runs/" + runId + "/stage", body, true);
        } catch (Exception e) {
            log.debug("postStageProgress failed runId={}: {}", runId, e.getMessage());
        }
    }

    private JsonNode postJson(String path, String jsonBody, boolean authed) throws Exception {
        String base = coordinatorUrl.endsWith("/")
                ? coordinatorUrl.substring(0, coordinatorUrl.length() - 1)
                : coordinatorUrl;
        HttpRequest.Builder rb = HttpRequest.newBuilder()
                .uri(URI.create(base + path))
                .timeout(Duration.ofSeconds(10))
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(jsonBody));
        if (authed) {
            String t = jwt.get();
            if (t != null) rb.header("Authorization", "Bearer " + t);
        }
        HttpResponse<String> resp = http.send(rb.build(), HttpResponse.BodyHandlers.ofString());
        if (resp.statusCode() == 401 || resp.statusCode() == 403) {
            throw new Unauthorized("HTTP " + resp.statusCode());
        }
        if (resp.statusCode() / 100 != 2) {
            throw new RuntimeException("HTTP " + resp.statusCode() + ": " + resp.body());
        }
        return mapper.readTree(resp.body());
    }

    private static String escape(String s) {
        return s.replace("\\", "\\\\").replace("\"", "\\\"");
    }

    /** Coordinator 의 /ws 에 STOMP 으로 연결 + /topic/worker/{username}/tasks 구독.
     *  JWT 는 STOMP CONNECT 헤더에 박는다. 끊김 / 재연결은 PoC 1차에서는 미구현 — 다음 사이클. */
    private void connectStomp() {
        try {
            WebSocketStompClient client = new WebSocketStompClient(new StandardWebSocketClient());
            client.setMessageConverter(new MappingJackson2MessageConverter());
            String base = coordinatorUrl.endsWith("/")
                    ? coordinatorUrl.substring(0, coordinatorUrl.length() - 1)
                    : coordinatorUrl;
            // /ws 는 브라우저용 SockJS endpoint. Worker 는 raw WebSocket 용 /ws-raw 사용.
            String wsUrl = base.replaceFirst("^http", "ws") + "/ws-raw";
            StompHeaders connectHeaders = new StompHeaders();
            String t = jwt.get();
            if (t != null) connectHeaders.add("Authorization", "Bearer " + t);
            client.connectAsync(wsUrl, new WebSocketHttpHeaders(), connectHeaders, new StompSessionHandlerAdapter() {
                @Override
                public void afterConnected(StompSession session, StompHeaders ch) {
                    log.info("Worker STOMP connected — subscribing /topic/worker/{}/tasks", workerUsername);
                    session.subscribe("/topic/worker/" + workerUsername + "/tasks", new StompFrameHandler() {
                        @Override public Type getPayloadType(StompHeaders headers) { return Map.class; }
                        @Override
                        public void handleFrame(StompHeaders headers, Object payload) {
                            handleStompMessage(payload);
                        }
                    });
                }
                @Override
                public void handleException(StompSession s, StompCommand cmd, StompHeaders h, byte[] payload, Throwable ex) {
                    log.warn("Worker STOMP exception cmd={}: {}", cmd, ex.getMessage());
                }
                @Override
                public void handleTransportError(StompSession s, Throwable ex) {
                    log.warn("Worker STOMP transport error: {}", ex.getMessage());
                    // 끊김 시 다음 register 사이클에서 다시 connect 시도하도록 flag 풀어준다.
                    stompConnected.set(false);
                }
            });
        } catch (Exception e) {
            stompConnected.set(false);
            log.warn("Worker STOMP connect failed: {}", e.getMessage());
        }
    }

    /**
     * RUN_START / RUN_CANCEL 처리. PING 은 향후. 그 외 type 은 debug log 만.
     *
     * RUN_START: worker process 안에서 별 thread 로 executeRun.
     * RUN_CANCEL: worker process 의 RunControlRegistry.cancel(runId) — running 중인 stage
     *             runner 가 깨어나 중단. DB 상태 변경은 Coordinator 가 finishRun 에서 수행.
     */
    @SuppressWarnings("unchecked")
    private void handleStompMessage(Object payload) {
        if (!(payload instanceof Map)) return;
        Map<String, Object> envelope = (Map<String, Object>) payload;
        String type = String.valueOf(envelope.get("type"));
        Object p = envelope.get("payload");
        if (!(p instanceof Map)) {
            log.debug("Worker ignoring envelope type={} (no payload)", type);
            return;
        }
        Map<String, Object> body = (Map<String, Object>) p;
        String runId = String.valueOf(body.get("runId"));

        switch (type) {
            case "RUN_START" -> {
                // STOMP 콜백 thread 는 막지 않는다 — 동시성 상한 풀에 제출. maxConcurrent 초과분은
                // 큐에서 대기 → 슬롯 나면 실행 (이전 raw-thread 방식은 상한이 없어 메모리 폭발).
                log.info("Worker received RUN_START runId={} (queued to run pool)", runId);
                runPool().submit(() -> {
                    try {
                        runExecutionListener.executeRun(runId);
                    } catch (Exception e) {
                        log.error("Worker run execution failed runId={}", runId, e);
                    }
                });
            }
            case "RUN_CANCEL" -> {
                String reason = String.valueOf(body.getOrDefault("reason", ""));
                log.info("Worker received RUN_CANCEL runId={} reason={}", runId, reason);
                try {
                    runControlRegistry.cancel(runId);
                } catch (Exception e) {
                    log.error("Worker cancel failed runId={}", runId, e);
                }
            }
            default -> log.debug("Worker ignoring envelope type={}", type);
        }
    }

    /** Marker exception so the heartbeat loop knows to re-login. */
    private static final class Unauthorized extends RuntimeException {
        Unauthorized(String m) { super(m); }
    }
}

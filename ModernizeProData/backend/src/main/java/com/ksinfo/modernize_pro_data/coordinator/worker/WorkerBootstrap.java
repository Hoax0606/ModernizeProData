package com.ksinfo.modernize_pro_data.coordinator.worker;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.annotation.PostConstruct;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

import java.net.InetAddress;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.time.OffsetDateTime;
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

    private final HttpClient http = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(5))
            .build();
    private final ObjectMapper mapper = new ObjectMapper();

    private final AtomicReference<String> jwt = new AtomicReference<>(null);
    private final AtomicReference<Status> status = new AtomicReference<>(Status.idle());

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
                    "{\"hostname\":\"" + escape(hostname()) + "\"}");
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
                    "{\"hostname\":\"" + escape(hostname()) + "\"}");
            String workerId = body.path("data").path("workerId").asText(null);
            updateStatus("registered", workerId, null);
            log.info("Self-registered as workerId={}", workerId);
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

    /** Marker exception so the heartbeat loop knows to re-login. */
    private static final class Unauthorized extends RuntimeException {
        Unauthorized(String m) { super(m); }
    }
}

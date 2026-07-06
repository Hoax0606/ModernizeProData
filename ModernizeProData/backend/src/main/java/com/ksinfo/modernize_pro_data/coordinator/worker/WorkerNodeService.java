package com.ksinfo.modernize_pro_data.coordinator.worker;

import com.ksinfo.modernize_pro_data.common.exception.ApiException;
import com.ksinfo.modernize_pro_data.coordinator.site.AuditLogService;
import com.ksinfo.modernize_pro_data.coordinator.user.User;
import com.ksinfo.modernize_pro_data.coordinator.user.UserRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Duration;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.Optional;

/**
 * worker_node lifecycle in the admin-user-login model.
 *
 * <ul>
 *   <li>{@link #selfRegister(String, String)} — Worker daemon's first call
 *       after logging in via JWT. Creates a row for (user, hostname) if absent,
 *       refreshes registered_at + last_seen_at if present.</li>
 *   <li>{@link #touchLastSeen(String)} — heartbeat throttle target.</li>
 *   <li>{@link #revoke(String, String)} — master can wipe a row from the
 *       Worker Nodes tab. The admin user account remains; the Worker daemon
 *       can recreate its row by logging in again.</li>
 * </ul>
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class WorkerNodeService {

    private final WorkerNodeRepository repo;
    private final UserRepository userRepository;
    private final AuditLogService auditLogService;

    @Transactional
    public WorkerNode selfRegister(String username, String hostname, String appVersion) {
        User user = userRepository.findByUsername(username)
                .orElseThrow(() -> new ApiException("USER_NOT_FOUND",
                        "User not found: " + username, HttpStatus.NOT_FOUND));
        String name = (hostname == null || hostname.isBlank()) ? user.getUsername() : hostname.trim();
        String version = (appVersion == null || appVersion.isBlank()) ? null : appVersion.trim();

        WorkerNode existing = repo.findFirstByUserIdAndNameOrderByCreatedAtDesc(user.getId(), name)
                .orElse(null);

        OffsetDateTime now = OffsetDateTime.now();
        if (existing != null) {
            existing.setStatus(WorkerStatus.REGISTERED);
            existing.setSiteId(user.getSiteId());
            existing.setLastSeenAt(now);
            if (version != null) existing.setAppVersion(version);
            if (existing.getRegisteredAt() == null) existing.setRegisteredAt(now);
            return repo.save(existing);
        }

        WorkerNode w = WorkerNode.createForUser(user.getId(), user.getSiteId(), name, user.getUsername(), version);
        repo.save(w);
        auditLogService.record(user.getSiteId(), null, user.getUsername(), "WORKER_REGISTERED")
                .target(hostname)
                .save();
        return w;
    }

    @Transactional
    public void touchLastSeen(String username, String hostname, String appVersion) {
        User user = userRepository.findByUsername(username).orElse(null);
        if (user == null) return;
        String name = (hostname == null || hostname.isBlank()) ? user.getUsername() : hostname.trim();
        String version = (appVersion == null || appVersion.isBlank()) ? null : appVersion.trim();
        repo.findFirstByUserIdAndNameOrderByCreatedAtDesc(user.getId(), name).ifPresent(w -> {
            w.setLastSeenAt(OffsetDateTime.now());
            if (version != null) w.setAppVersion(version);
            repo.save(w);
        });
    }

    @Transactional
    public void revoke(String workerId, String actor) {
        WorkerNode w = repo.findById(workerId).orElseThrow(() ->
                new ApiException("WORKER_NOT_FOUND", "Worker not found: " + workerId, HttpStatus.NOT_FOUND));
        // Kill the owner user's active session so the Worker daemon's next
        // heartbeat / API call gets sid-mismatch 401, which the WebView
        // interceptor translates to an automatic logout. Without this the
        // existing JWT would stay valid until expiry.
        if (w.getUserId() != null) {
            userRepository.findById(w.getUserId()).ifPresent(u -> {
                u.setCurrentSessionId(null);
                u.setCurrentSessionIssuedAt(null);
                u.setCurrentSessionExpiresAt(null);
                userRepository.save(u);
            });
        }
        auditLogService.record(w.getSiteId(), null, actor, "WORKER_REVOKED")
                .target(w.getWorkerId())
                .save();
        // Drop the row entirely. Master can issue a new admin user / new PC
        // login to get a fresh worker_node row.
        repo.delete(w);
    }

    public List<WorkerNode> list() {
        return repo.findAllByOrderByCreatedAtDesc();
    }

    /** Worker online 판단 timeout — heartbeat 가 이 시간 안에 들어왔어야 online. */
    private static final long ONLINE_TIMEOUT_SECONDS = 90;

    /**
     * 주어진 username 으로 등록된 worker 중 가장 최근에 heartbeat 받은 것이 status=REGISTERED 이고
     * last_seen_at 이 timeout 이내면 그 worker. 그 외엔 empty.
     *
     * RunService.startRun 이 assignee 의 worker 가 online 인지 확인할 때 사용.
     */
    public Optional<WorkerNode> findOnlineForUsername(String username) {
        if (username == null || username.isBlank()) return Optional.empty();
        User user = userRepository.findByUsername(username).orElse(null);
        if (user == null) return Optional.empty();
        return repo.findFirstByUserIdOrderByLastSeenAtDesc(user.getId())
                .filter(w -> w.getStatus() == WorkerStatus.REGISTERED)
                .filter(this::isOnline);
    }

    /** last_seen_at 기준 online 판정 — null 또는 timeout 초과 시 offline. */
    public boolean isOnline(WorkerNode w) {
        OffsetDateTime ts = w.getLastSeenAt();
        if (ts == null) return false;
        return Duration.between(ts, OffsetDateTime.now()).toSeconds() <= ONLINE_TIMEOUT_SECONDS;
    }
}

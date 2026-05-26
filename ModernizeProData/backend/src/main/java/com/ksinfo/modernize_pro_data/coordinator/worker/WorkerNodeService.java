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

import java.time.OffsetDateTime;
import java.util.List;

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
    public WorkerNode selfRegister(String username, String hostname) {
        User user = userRepository.findByUsername(username)
                .orElseThrow(() -> new ApiException("USER_NOT_FOUND",
                        "User not found: " + username, HttpStatus.NOT_FOUND));
        String name = (hostname == null || hostname.isBlank()) ? user.getUsername() : hostname.trim();

        WorkerNode existing = repo.findFirstByUserIdAndNameOrderByCreatedAtDesc(user.getId(), name)
                .orElse(null);

        OffsetDateTime now = OffsetDateTime.now();
        if (existing != null) {
            existing.setStatus(WorkerStatus.REGISTERED);
            existing.setSiteId(user.getSiteId());
            existing.setLastSeenAt(now);
            if (existing.getRegisteredAt() == null) existing.setRegisteredAt(now);
            return repo.save(existing);
        }

        WorkerNode w = WorkerNode.createForUser(user.getId(), user.getSiteId(), name, user.getUsername());
        repo.save(w);
        auditLogService.record(user.getSiteId(), null, user.getUsername(), "WORKER_REGISTERED")
                .target(hostname)
                .save();
        return w;
    }

    @Transactional
    public void touchLastSeen(String username, String hostname) {
        User user = userRepository.findByUsername(username).orElse(null);
        if (user == null) return;
        String name = (hostname == null || hostname.isBlank()) ? user.getUsername() : hostname.trim();
        repo.findFirstByUserIdAndNameOrderByCreatedAtDesc(user.getId(), name).ifPresent(w -> {
            w.setLastSeenAt(OffsetDateTime.now());
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
}

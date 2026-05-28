package com.ksinfo.modernize_pro_data.coordinator.api;

import com.ksinfo.modernize_pro_data.common.dto.ApiResponse;
import com.ksinfo.modernize_pro_data.coordinator.worker.WorkerNode;
import com.ksinfo.modernize_pro_data.coordinator.worker.WorkerNodeService;
import com.ksinfo.modernize_pro_data.coordinator.worker.WorkerStatus;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.time.OffsetDateTime;
import java.util.List;

/**
 * Worker node endpoints.
 *
 * <ul>
 *   <li>master 한정: list / revoke. token 발급은 없음 (login 모델 채택).</li>
 *   <li>인증된 모든 user (admin / Worker daemon 의 login 후) : self-register / heartbeat.</li>
 * </ul>
 */
@Slf4j
@RestController
@RequestMapping("/api/v1/workers")
@RequiredArgsConstructor
public class WorkerController {

    private final WorkerNodeService workerNodeService;

    public record WorkerSummaryDto(
            String workerId,
            String name,
            String siteId,
            String userId,
            WorkerStatus status,
            OffsetDateTime registeredAt,
            OffsetDateTime lastSeenAt,
            OffsetDateTime createdAt,
            String createdBy
    ) {
        static WorkerSummaryDto from(WorkerNode w) {
            return new WorkerSummaryDto(
                    w.getWorkerId(), w.getName(), w.getSiteId(), w.getUserId(),
                    w.getStatus(),
                    w.getRegisteredAt(), w.getLastSeenAt(),
                    w.getCreatedAt(), w.getCreatedBy());
        }
    }

    public record RegisterRequest(String hostname) {}

    @GetMapping
    @PreAuthorize("hasRole('MASTER')")
    public ApiResponse<List<WorkerSummaryDto>> list() {
        return ApiResponse.ok(workerNodeService.list().stream()
                .map(WorkerSummaryDto::from)
                .toList());
    }

    @DeleteMapping("/{workerId}")
    @PreAuthorize("hasRole('MASTER')")
    public ApiResponse<Void> revoke(@PathVariable String workerId, Authentication auth) {
        workerNodeService.revoke(workerId, auth.getName());
        return ApiResponse.ok(null);
    }

    /**
     * Worker daemon's first call after a successful /auth/login. The principal
     * is the admin user's username; the daemon supplies its hostname so the
     * Coordinator can distinguish multiple PCs sharing one user.
     */
    @PostMapping("/self-register")
    public ApiResponse<WorkerSummaryDto> selfRegister(
            @RequestBody RegisterRequest req,
            Authentication auth
    ) {
        WorkerNode w = workerNodeService.selfRegister(auth.getName(), req.hostname());
        return ApiResponse.ok(WorkerSummaryDto.from(w));
    }

    @PostMapping("/heartbeat")
    public ApiResponse<Void> heartbeat(
            @RequestBody RegisterRequest req,
            Authentication auth
    ) {
        workerNodeService.touchLastSeen(auth.getName(), req.hostname());
        return ApiResponse.ok(null);
    }
}

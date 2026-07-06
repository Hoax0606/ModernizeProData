package com.ksinfo.modernize_pro_data.coordinator.worker;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import lombok.AllArgsConstructor;
import lombok.Getter;
import lombok.NoArgsConstructor;
import lombok.Setter;

import java.time.OffsetDateTime;
import java.util.UUID;

/**
 * Coordinator's record of one self-registered Worker node.
 *
 * <p>An admin-role user logs in to their Coordinator from a field PC; the
 * Worker daemon then POSTs /api/v1/workers/self-register and either creates
 * a row here or refreshes the existing one. {@link #userId} is the admin
 * user that owns this PC; {@link #siteId} mirrors that user's site_id at
 * register time so the Worker Nodes table can group by site.
 */
@Entity
@Table(name = "worker_node")
@Getter @Setter
@NoArgsConstructor
@AllArgsConstructor
public class WorkerNode {

    @Id
    @Column(name = "worker_id", length = 40)
    private String workerId;

    @Column(nullable = false, length = 128)
    private String name;

    @Column(name = "site_id", length = 40)
    private String siteId;

    @Column(name = "user_id", length = 40)
    private String userId;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false, length = 16)
    private WorkerStatus status;

    @Column(name = "registered_at")
    private OffsetDateTime registeredAt;

    @Column(name = "last_seen_at")
    private OffsetDateTime lastSeenAt;

    /** Worker daemon 이 보고한 설치 앱 버전 (예: 1.0.25). 구버전 워커는 NULL. */
    @Column(name = "app_version", length = 32)
    private String appVersion;

    @Column(name = "created_at", nullable = false)
    private OffsetDateTime createdAt;

    @Column(name = "created_by", nullable = false, length = 64)
    private String createdBy;

    static WorkerNode createForUser(String userId, String siteId, String hostname,
                                    String createdBy, String appVersion) {
        WorkerNode w = new WorkerNode();
        w.workerId = "w-" + UUID.randomUUID().toString().substring(0, 8);
        w.name = hostname;
        w.siteId = (siteId != null && !siteId.isBlank()) ? siteId : null;
        w.userId = userId;
        w.status = WorkerStatus.REGISTERED;
        w.registeredAt = OffsetDateTime.now();
        w.lastSeenAt = w.registeredAt;
        w.appVersion = appVersion;
        w.createdAt = w.registeredAt;
        w.createdBy = createdBy;
        return w;
    }
}

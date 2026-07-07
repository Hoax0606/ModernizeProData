package com.ksinfo.modernize_pro_data.coordinator.site;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import lombok.AllArgsConstructor;
import lombok.Getter;
import lombok.NoArgsConstructor;
import lombok.Setter;

import java.time.OffsetDateTime;
import java.util.UUID;

/**
 * Site 단위 audit log — 모든 사용자 액션의 server-side 기록.
 * 모든 계정 (master / worker) 이 동일하게 조회.
 */
@Entity
@Table(name = "audit_log")
@Getter @Setter
@NoArgsConstructor
@AllArgsConstructor
public class AuditLog {

    @Id
    @Column(length = 40)
    private String id;

    @Column(name = "site_id", nullable = false, length = 40)
    private String siteId;

    @Column(name = "project_id", length = 40)
    private String projectId;

    @Column(nullable = false, length = 64)
    private String username;

    @Column(nullable = false, length = 64)
    private String action;

    @Column(length = 256)
    private String target;

    @Column(columnDefinition = "TEXT")
    private String details;

    @Column(name = "snapshot_id", length = 40)
    private String snapshotId;

    @Column(name = "snapshot_name", length = 256)
    private String snapshotName;

    @Column(nullable = false)
    private OffsetDateTime timestamp;

    public static AuditLog create(String siteId, String projectId, String username, String action) {
        AuditLog a = new AuditLog();
        a.id = "a-" + UUID.randomUUID().toString().substring(0, 8);
        a.siteId = siteId;
        a.projectId = projectId;
        a.username = username;
        a.action = action;
        a.timestamp = OffsetDateTime.now();
        return a;
    }
}

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

@Entity
@Table(name = "snapshots")
@Getter @Setter
@NoArgsConstructor
@AllArgsConstructor
public class Snapshot {

    @Id
    @Column(length = 40)
    private String id;

    @Column(name = "project_id", nullable = false, length = 40)
    private String projectId;

    @Column(nullable = false, length = 128)
    private String name;

    @Column(nullable = false, length = 16)
    private String version;

    @Column(columnDefinition = "TEXT")
    private String description;

    @Column(nullable = false, length = 16)
    private String type;

    @Column(nullable = false, length = 16)
    private String status;

    @Column(name = "created_by", nullable = false, length = 64)
    private String createdBy;

    @Column(name = "created_at", nullable = false)
    private OffsetDateTime createdAt;

    @Column(name = "approved_by", length = 64)
    private String approvedBy;

    @Column(name = "approved_at")
    private OffsetDateTime approvedAt;

    @Column(name = "rejected_by", length = 64)
    private String rejectedBy;

    @Column(name = "rejected_at")
    private OffsetDateTime rejectedAt;

    @Column(name = "rejection_reason", columnDefinition = "TEXT")
    private String rejectionReason;

    @Column(name = "table_count", nullable = false)
    private int tableCount;

    @Column(name = "rule_count", nullable = false)
    private int ruleCount;

    public static Snapshot create(String projectId, String name, String description,
                                  String type, String createdBy, int tableCount, int ruleCount, String nextVersion) {
        Snapshot s = new Snapshot();
        s.id = "ss-" + UUID.randomUUID().toString().substring(0, 8);
        s.projectId = projectId;
        s.name = name;
        s.version = nextVersion;
        s.description = description;
        s.type = type != null ? type : "mapping";
        s.status = "draft";
        s.createdBy = createdBy;
        s.createdAt = OffsetDateTime.now();
        s.tableCount = tableCount;
        s.ruleCount = ruleCount;
        return s;
    }

    // 기존 create 메서드 오버로드 (하위 호환성)
    public static Snapshot create(String projectId, String name, String description,
                                  String type, String createdBy, int tableCount, int ruleCount) {
        return create(projectId, name, description, type, createdBy, tableCount, ruleCount, "v1.0");
    }
    
    public static String generateNextVersion(String latestVersion) {
        if (latestVersion == null || latestVersion.isEmpty()) {
            return "v1.0";
        }
        
        // v1.2 -> 1.2 -> [1, 2] -> 1.3 -> v1.3
        if (latestVersion.startsWith("v")) {
            latestVersion = latestVersion.substring(1);
        }
        
        String[] parts = latestVersion.split("\\.");
        if (parts.length >= 2) {
            try {
                int major = Integer.parseInt(parts[0]);
                int minor = Integer.parseInt(parts[1]);
                return String.format("v%d.%d", major, minor + 1);
            } catch (NumberFormatException e) {
                // fallback
            }
        }
        
        return "v1.0";
    }
}

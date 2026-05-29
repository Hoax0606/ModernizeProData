package com.ksinfo.modernize_pro_data.coordinator.site;

import com.ksinfo.modernize_pro_data.coordinator.site.frozen.SnapshotChanges;
import com.ksinfo.modernize_pro_data.coordinator.site.frozen.SnapshotData;
import com.ksinfo.modernize_pro_data.coordinator.site.frozen.SnapshotExecutionContext;
import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import lombok.AllArgsConstructor;
import lombok.Getter;
import lombok.NoArgsConstructor;
import lombok.Setter;
import org.hibernate.annotations.JdbcTypeCode;
import org.hibernate.type.SqlTypes;

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

    @Column(name = "code_map_count", nullable = false)
    private int codeMapCount;

    /**
     * 프로젝트의 현재 "고정핀" 표시. partial unique index 가 project_id 당 단 1개만 허용.
     * MappingPage 등 다른 컨텍스트가 "현재 기준 snapshot" 을 찾을 때 사용.
     */
    @Column(name = "is_baseline", nullable = false)
    private boolean baseline;

    /**
     * 생성 시점의 mapping working set (rules + codeMaps + bindings) 동결본.
     * Immutable — 한 번 채워진 뒤 라이브 mapping 변경에 영향받지 않는다.
     */
    @JdbcTypeCode(SqlTypes.JSON)
    @Column(name = "snapshot_data", columnDefinition = "jsonb")
    private SnapshotData snapshotData;

    /** 비교 기준 (baseline 우선, 없으면 시간순 직전). 첫 snapshot 이면 null. */
    @Column(name = "previous_version_id", length = 40)
    private String previousVersionId;

    /** 생성 시점에 박제된 이전 버전 대비 changes. immutable. */
    @JdbcTypeCode(SqlTypes.JSON)
    @Column(name = "changes", columnDefinition = "jsonb")
    private SnapshotChanges changes;

    /** 이 snapshot 으로 실행된 가장 최근 run 의 종료 시점 박제본.
     *  RunService.finishRun → SnapshotExecutionContextService 가 갱신한다.
     *  같은 snapshot 으로 여러 번 run 하면 덮어쓴다. 아직 실행 안 한 snapshot 은 null. */
    @JdbcTypeCode(SqlTypes.JSON)
    @Column(name = "execution_context", columnDefinition = "jsonb")
    private SnapshotExecutionContext executionContext;

    public static Snapshot create(String projectId, String name, String description,
                                  String type, String createdBy, String nextVersion) {
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
        // tableCount / ruleCount / codeMapCount 은 freeze 직후 실측치로 채운다.
        return s;
    }

    /**
     * 다음 버전 번호를 결정한다.
     *   - 직전 snapshot 이 approved 이면 major bump (v1.x → v2.0)
     *   - 그 외 (rejected / pending / draft) 면 minor bump (v1.0 → v1.1)
     */
    public static String generateNextVersion(String latestVersion, String latestStatus) {
        if (latestVersion == null || latestVersion.isEmpty()) {
            return "v1.0";
        }

        // v1.2 -> 1.2 -> [1, 2]
        if (latestVersion.startsWith("v")) {
            latestVersion = latestVersion.substring(1);
        }

        String[] parts = latestVersion.split("\\.");
        if (parts.length >= 2) {
            try {
                int major = Integer.parseInt(parts[0]);
                int minor = Integer.parseInt(parts[1]);
                if ("approved".equalsIgnoreCase(latestStatus)) {
                    return String.format("v%d.0", major + 1);
                }
                return String.format("v%d.%d", major, minor + 1);
            } catch (NumberFormatException e) {
                // fallback
            }
        }

        return "v1.0";
    }
}

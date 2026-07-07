package com.ksinfo.modernize_pro_data.coordinator.run;

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
import org.hibernate.annotations.JdbcTypeCode;
import org.hibernate.type.SqlTypes;

import java.time.OffsetDateTime;
import java.util.Map;
import java.util.UUID;

/**
 * Run 1 회분의 詳細履歴.
 *
 * projects.run_status (3 값: idle/running/completed) 가 UI 表示用 "지금" 상태라면,
 * RunHistory 는 監査・분석용 完全履歴.
 */
@Entity
@Table(name = "run_history")
@Getter @Setter
@NoArgsConstructor
@AllArgsConstructor
public class RunHistory {

    @Id
    @Column(length = 40)
    private String id;

    @Column(name = "project_id", nullable = false, length = 40)
    private String projectId;

    @Enumerated(EnumType.STRING)
    @Column(name = "run_type", nullable = false, length = 16)
    private RunType runType;

    @Enumerated(EnumType.STRING)
    @Column(name = "trigger_source", nullable = false, length = 16)
    private TriggerSource triggerSource;

    @Column(name = "requested_by", nullable = false, length = 64)
    private String requestedBy;

    @Column(name = "credential_id", length = 40)
    private String credentialId;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false, length = 16)
    private RunStatus status;

    @Column(name = "started_at", nullable = false)
    private OffsetDateTime startedAt;

    @Column(name = "finished_at")
    private OffsetDateTime finishedAt;

    @Column(name = "duration_ms")
    private Long durationMs;

    @Column(name = "snapshot_id", length = 40)
    private String snapshotId;

    @Column(name = "batch_job_execution_id")
    private Long batchJobExecutionId;

    /**
     * 実제로 처리한 worker node 식별자 (단일 worker 운용 시 "default").
     * dispatch 시점에 셋되며、Worker callback 가 다른 ID 를 보고하면 上書 (멀티 worker 대응).
     */
    @Column(name = "worker_id", length = 40)
    private String workerId;

    @Column(name = "error_message", columnDefinition = "TEXT")
    private String errorMessage;

    @JdbcTypeCode(SqlTypes.JSON)
    @Column(columnDefinition = "jsonb")
    private Map<String, Object> metadata;

    /**
     * 新規 run 시 생성. status = pending, started_at = now.
     * 그 후 RunService 가 running → success/failed/etc. 으로 전이.
     */
    public static RunHistory create(String projectId,
                                    RunType runType,
                                    TriggerSource triggerSource,
                                    String requestedBy,
                                    String credentialId,
                                    String snapshotId) {
        RunHistory rh = new RunHistory();
        rh.id = "r-" + UUID.randomUUID().toString().substring(0, 8);
        rh.projectId = projectId;
        rh.runType = runType;
        rh.triggerSource = triggerSource;
        rh.requestedBy = requestedBy;
        rh.credentialId = credentialId;
        rh.snapshotId = snapshotId;
        rh.status = RunStatus.pending;
        rh.startedAt = OffsetDateTime.now();
        rh.metadata = Map.of();
        return rh;
    }
}

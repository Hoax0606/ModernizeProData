package com.ksinfo.modernize_pro_data.coordinator.run.stage;

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
 * 한 run 의 한 stage 진행 상태.
 * startRun 시점에 runType 의 stage list 만큼 pre-create (모두 status=pending).
 */
@Entity
@Table(name = "stage_instances")
@Getter @Setter
@NoArgsConstructor
@AllArgsConstructor
public class StageInstance {

    @Id
    @Column(length = 40)
    private String id;

    @Column(name = "run_id", nullable = false, length = 40)
    private String runId;

    @Column(name = "stage_key", nullable = false, length = 16)
    private String stageKey;

    @Column(nullable = false)
    private Short seq;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false, length = 16)
    private StageStatus status;

    @Column(name = "started_at")
    private OffsetDateTime startedAt;

    @Column(name = "finished_at")
    private OffsetDateTime finishedAt;

    @Column(name = "duration_ms")
    private Long durationMs;

    @Column(name = "tables_total", nullable = false)
    private Integer tablesTotal;

    @Column(name = "tables_success", nullable = false)
    private Integer tablesSuccess;

    @Column(name = "tables_failed", nullable = false)
    private Integer tablesFailed;

    @Column(name = "error_summary", columnDefinition = "TEXT")
    private String errorSummary;

    public static StageInstance create(String runId, String stageKey, int seq, int tablesTotal) {
        StageInstance si = new StageInstance();
        si.id = "si-" + UUID.randomUUID().toString().substring(0, 8);
        si.runId = runId;
        si.stageKey = stageKey;
        si.seq = (short) seq;
        si.status = StageStatus.pending;
        si.tablesTotal = tablesTotal;
        si.tablesSuccess = 0;
        si.tablesFailed = 0;
        return si;
    }
}

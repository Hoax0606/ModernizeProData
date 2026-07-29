package com.ksinfo.modernize_pro_data.coordinator.run.delta;

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
 * CDC 증분(delta) 이행 워터마크 — 프로젝트 × TO-BE 테이블별로 "어느 SCN 까지 적용했는지"
 * 지속(cross-run) 커서. 델타 run 성공 후 upsert. 상세는 V20260729100100__delta_watermark.sql.
 */
@Entity
@Table(name = "delta_watermark")
@Getter @Setter
@NoArgsConstructor
@AllArgsConstructor
public class DeltaWatermark {

    @Id
    @Column(length = 40)
    private String id;

    @Column(name = "project_id", nullable = false, length = 40)
    private String projectId;

    @Column(name = "tobe_schema", nullable = false, length = 128)
    private String tobeSchema;

    @Column(name = "tobe_table", nullable = false, length = 128)
    private String tobeTable;

    @Column(name = "last_applied_scn")
    private Long lastAppliedScn;

    @Column(name = "last_run_id", length = 40)
    private String lastRunId;

    @Column(name = "updated_at", nullable = false)
    private OffsetDateTime updatedAt;

    public static DeltaWatermark create(String projectId, String tobeSchema, String tobeTable) {
        DeltaWatermark w = new DeltaWatermark();
        w.id = "dw-" + UUID.randomUUID().toString().substring(0, 8);
        w.projectId = projectId;
        w.tobeSchema = tobeSchema == null ? "" : tobeSchema;
        w.tobeTable = tobeTable;
        w.updatedAt = OffsetDateTime.now();
        return w;
    }
}

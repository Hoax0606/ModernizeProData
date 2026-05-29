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
import org.hibernate.annotations.JdbcTypeCode;
import org.hibernate.type.SqlTypes;

import java.time.OffsetDateTime;
import java.util.Map;
import java.util.UUID;

/**
 * 한 stage 안 1 테이블 처리 결과. lazy insert (worker 가 table dispatch 시점에 추가).
 * tobe_schema / tobe_table 은 비정규화 — binding 이 수정되어도 run 기록은 그대로 읽혀야.
 */
@Entity
@Table(name = "stage_table_results")
@Getter @Setter
@NoArgsConstructor
@AllArgsConstructor
public class StageTableResult {

    @Id
    @Column(length = 40)
    private String id;

    @Column(name = "stage_instance_id", nullable = false, length = 40)
    private String stageInstanceId;

    @Column(name = "binding_id", nullable = false, length = 40)
    private String bindingId;

    @Column(name = "tobe_schema", nullable = false, length = 128)
    private String tobeSchema;

    @Column(name = "tobe_table", nullable = false, length = 128)
    private String tobeTable;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false, length = 16)
    private StageTableStatus status;

    @Column(name = "started_at", nullable = false)
    private OffsetDateTime startedAt;

    @Column(name = "finished_at")
    private OffsetDateTime finishedAt;

    @Column(name = "duration_ms")
    private Long durationMs;

    @Column(name = "row_count")
    private Long rowCount;

    @Column(name = "error_count")
    private Integer errorCount;

    @JdbcTypeCode(SqlTypes.JSON)
    @Column(name = "error_detail", columnDefinition = "jsonb")
    private Map<String, Object> errorDetail;

    /** TransformStage 가 생성·실행한 CREATE OR REPLACE TABLE ... SELECT ... 텍스트.
     *  ArtifactsPage 의 MIGRATION SQL 카테고리에서 표시 — run 시점에 박제되므로 mapping_rules 가
     *  나중에 바뀌어도 그 run 에서 실제로 돌았던 SQL 이 그대로 남는다. */
    @Column(name = "compiled_sql", columnDefinition = "text")
    private String compiledSql;

    public static StageTableResult create(String stageInstanceId, String bindingId,
                                          String tobeSchema, String tobeTable) {
        StageTableResult str = new StageTableResult();
        str.id = "str-" + UUID.randomUUID().toString().substring(0, 8);
        str.stageInstanceId = stageInstanceId;
        str.bindingId = bindingId;
        str.tobeSchema = tobeSchema == null ? "" : tobeSchema;
        str.tobeTable = tobeTable;
        str.status = StageTableStatus.running;
        str.startedAt = OffsetDateTime.now();
        return str;
    }
}

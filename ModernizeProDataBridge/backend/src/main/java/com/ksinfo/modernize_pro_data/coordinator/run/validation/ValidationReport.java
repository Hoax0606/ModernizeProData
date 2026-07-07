package com.ksinfo.modernize_pro_data.coordinator.run.validation;

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
import java.util.Map;
import java.util.UUID;

/**
 * 한 run 의 한 binding 에 대한 validation aggregate 결과 박제.
 *
 * Verify 직후 {@link ValidationReportService#compute} 가 작성. Stage 가 아니므로
 * stage_instances 의 CHECK constraint 영향 없음. {@code report_data} 에 시트별 raw
 * 데이터가 들어가고, FE 는 {@link ValidationReportController} 의 DTO 로 받아 Cell[][] 변환.
 */
@Entity
@Table(name = "validation_reports")
@Getter @Setter
@NoArgsConstructor
@AllArgsConstructor
public class ValidationReport {

    @Id
    @Column(length = 40)
    private String id;

    @Column(name = "run_id", nullable = false, length = 40)
    private String runId;

    @Column(name = "binding_id", nullable = false, length = 40)
    private String bindingId;

    @Column(name = "tobe_schema", nullable = false, length = 128)
    private String tobeSchema;

    @Column(name = "tobe_table", nullable = false, length = 128)
    private String tobeTable;

    @Column(name = "generated_at", nullable = false)
    private OffsetDateTime generatedAt;

    @Column(name = "total_checks", nullable = false)
    private int totalChecks;

    @Column(name = "passed_checks", nullable = false)
    private int passedChecks;

    /** 시트별 raw 데이터. keys: overview / sumRecon / nullParity / minMax / typeValid / rowCount / checksum */
    @JdbcTypeCode(SqlTypes.JSON)
    @Column(name = "report_data", nullable = false, columnDefinition = "jsonb")
    private Map<String, Object> reportData;

    /** 계산 자체 실패 시 사유. 정상이면 null. */
    @Column(name = "error_summary", columnDefinition = "text")
    private String errorSummary;

    public static ValidationReport create(String runId, String bindingId,
                                          String tobeSchema, String tobeTable) {
        ValidationReport r = new ValidationReport();
        r.id = "vr-" + UUID.randomUUID().toString().substring(0, 8);
        r.runId = runId;
        r.bindingId = bindingId;
        r.tobeSchema = tobeSchema == null ? "" : tobeSchema;
        r.tobeTable = tobeTable;
        r.generatedAt = OffsetDateTime.now();
        return r;
    }
}

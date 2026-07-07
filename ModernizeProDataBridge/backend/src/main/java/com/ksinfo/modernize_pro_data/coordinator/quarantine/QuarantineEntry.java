package com.ksinfo.modernize_pro_data.coordinator.quarantine;

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
 * Stage 실행 중 validation rule 위반 row 의 group summary.
 *
 * 한 row = (run, stage, binding, rule) 단위 group 1개. 같은 (rule) 의 여러 row 는 row_count 로 누적.
 * 첫 5 row 만 sample_data JSONB 에 저장. 전체 raw 는 output 디렉토리의 parquet.
 */
@Entity
@Table(name = "quarantine_entries")
@Getter @Setter
@NoArgsConstructor
@AllArgsConstructor
public class QuarantineEntry {

    @Id
    @Column(length = 40)
    private String id;

    @Column(name = "run_id", nullable = false, length = 40)
    private String runId;

    @Column(name = "stage_instance_id", nullable = false, length = 40)
    private String stageInstanceId;

    @Column(name = "binding_id", nullable = false, length = 40)
    private String bindingId;

    @Column(name = "rule_id", length = 40)
    private String ruleId;

    @Column(name = "rule_name", nullable = false, length = 128)
    private String ruleName;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false, length = 16)
    private QuarantineSeverity severity;

    /**
     * Free-form JSONB. 프론트엔드 QuarantineGroup 와 동일 구조:
     *   columns       : List<String> — sample row 의 컬럼 헤더 (pk + violated + context, 3종)
     *   columnRoles   : List<String> — 각 컬럼의 역할 (pk / violated / context)
     *   sampleRows    : List<List<Object>> — 첫 N row 의 값
     *   toBeValues    : List<Object> (선택) — 변환 시도 결과 (null 이면 거부)
     *   reason        : String — 짧은 제목 (예: "FK violation — child key not found in parent")
     *   detail        : String — 세부 (예: "GL_ENTRY.acct_no → ACCT_MASTER.account_no")
     *   table         : String — 대상 테이블
     *   stageLabel    : String — 검증 stage label (예: "validate.fk")
     */
    @JdbcTypeCode(SqlTypes.JSON)
    @Column(name = "sample_data", columnDefinition = "jsonb")
    private Map<String, Object> sampleData;

    @Column(name = "row_count", nullable = false)
    private Long rowCount;

    @Column(name = "log_line_seq")
    private Long logLineSeq;

    @Column(name = "created_at", nullable = false)
    private OffsetDateTime createdAt;

    public static QuarantineEntry create(String runId, String stageInstanceId,
                                         String bindingId, String ruleId, String ruleName,
                                         QuarantineSeverity severity,
                                         Map<String, Object> sampleData,
                                         long rowCount, Long logLineSeq) {
        QuarantineEntry q = new QuarantineEntry();
        q.id = "q-" + UUID.randomUUID().toString().substring(0, 8);
        q.runId = runId;
        q.stageInstanceId = stageInstanceId;
        q.bindingId = bindingId;
        q.ruleId = ruleId;
        q.ruleName = ruleName;
        q.severity = severity;
        q.sampleData = sampleData;
        q.rowCount = rowCount;
        q.logLineSeq = logLineSeq;
        q.createdAt = OffsetDateTime.now();
        return q;
    }
}

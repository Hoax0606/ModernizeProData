package com.ksinfo.modernize_pro_data.coordinator.quarantine;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import lombok.AllArgsConstructor;
import lombok.Getter;
import lombok.NoArgsConstructor;
import lombok.Setter;

import java.time.OffsetDateTime;

/**
 * 운영자의 WARN 그룹 ack 기록.
 *
 * Scope = per-stageLabel (rule_name + binding_id + reason). 같은 fingerprint 의 모든
 * WARN row 가 한 ack 로 처리됨. WARN 만 있는 stage 는 ack 없으면 failed_with_pending_warnings
 * 로 차단, ack 있으면 통과.
 *
 * Carry-over (옵션 C — 조건부):
 *   같은 (project, binding, rule_name, reason, csv_mtime_ms, csv_size, phase) 매칭 시
 *   다음 run 에 자동 적용.
 *
 * Phase 정책:
 *   - test → test: carry-over OK
 *   - test → rehearsal: 차단 (별도 ack)
 *   - rehearsal → rehearsal: carry-over OK
 *   - rehearsal → cutover: carry-over OK (default 채택, 운영자 최종 확인)
 *   - cutover → cutover: carry-over OK
 */
@Entity
@Table(name = "quarantine_acknowledgments")
@Getter @Setter
@NoArgsConstructor
@AllArgsConstructor
public class QuarantineAcknowledgment {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(name = "project_id", nullable = false, length = 40)
    private String projectId;

    @Column(name = "binding_id", nullable = false, length = 40)
    private String bindingId;

    @Column(name = "rule_name", nullable = false, length = 128)
    private String ruleName;

    @Column(name = "reason", nullable = false, columnDefinition = "TEXT")
    private String reason;

    /** CSV file last-modified (ms). NULL = unknown — carry-over 미적용. */
    @Column(name = "csv_mtime_ms")
    private Long csvMtimeMs;

    /** CSV file size (byte). NULL = unknown — carry-over 미적용. */
    @Column(name = "csv_size")
    private Long csvSize;

    /** test / rehearsal / cutover */
    @Column(name = "phase", nullable = false, length = 20)
    private String phase;

    @Column(name = "acknowledged_by", nullable = false, length = 50)
    private String acknowledgedBy;

    @Column(name = "acknowledged_at", nullable = false)
    private OffsetDateTime acknowledgedAt;

    @Column(name = "note", columnDefinition = "TEXT")
    private String note;

    public static QuarantineAcknowledgment create(String projectId, String bindingId,
                                                  String ruleName, String reason,
                                                  Long csvMtimeMs, Long csvSize,
                                                  String phase, String acknowledgedBy,
                                                  String note) {
        QuarantineAcknowledgment a = new QuarantineAcknowledgment();
        a.projectId = projectId;
        a.bindingId = bindingId;
        a.ruleName = ruleName;
        a.reason = reason;
        a.csvMtimeMs = csvMtimeMs;
        a.csvSize = csvSize;
        a.phase = phase;
        a.acknowledgedBy = acknowledgedBy;
        a.acknowledgedAt = OffsetDateTime.now();
        a.note = note;
        return a;
    }
}

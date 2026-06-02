package com.ksinfo.modernize_pro_data.coordinator.quarantine;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.util.List;
import java.util.Optional;

public interface QuarantineAcknowledgmentRepository extends JpaRepository<QuarantineAcknowledgment, Long> {

    /**
     * Carry-over 조회 — fingerprint 일치 + phase 매칭.
     *
     * Phase 매칭 규칙 (정책 7):
     *   - currentPhase=test      → ack.phase IN (test)
     *   - currentPhase=rehearsal → ack.phase IN (rehearsal)
     *   - currentPhase=cutover   → ack.phase IN (rehearsal, cutover)
     *
     * CSV fingerprint (csv_mtime_ms + csv_size) 가 모두 일치해야 carry-over.
     * 둘 중 하나라도 NULL 이면 carry-over 미적용 (안전 우선).
     *
     * reason 직접 비교 대신 reason_hash (CHAR(64)) 비교 — TEXT 인덱스 회피.
     */
    @Query("""
        SELECT a FROM QuarantineAcknowledgment a
         WHERE a.projectId  = :projectId
           AND a.bindingId  = :bindingId
           AND a.ruleName   = :ruleName
           AND a.reasonHash = :reasonHash
           AND a.csvMtimeMs = :csvMtimeMs
           AND a.csvSize    = :csvSize
           AND a.phase IN :allowedPhases
         ORDER BY a.acknowledgedAt DESC
        """)
    List<QuarantineAcknowledgment> findCarryOver(@Param("projectId") String projectId,
                                                 @Param("bindingId") String bindingId,
                                                 @Param("ruleName")  String ruleName,
                                                 @Param("reasonHash") String reasonHash,
                                                 @Param("csvMtimeMs") Long csvMtimeMs,
                                                 @Param("csvSize")    Long csvSize,
                                                 @Param("allowedPhases") List<String> allowedPhases);

    /** 운영자가 명시 ack 한 가장 최근 row 1건 (carry-over 결정용). */
    default Optional<QuarantineAcknowledgment> findLatestCarryOver(String projectId, String bindingId,
                                                                   String ruleName, String reason,
                                                                   Long csvMtimeMs, Long csvSize,
                                                                   List<String> allowedPhases) {
        if (csvMtimeMs == null || csvSize == null) return Optional.empty();
        List<QuarantineAcknowledgment> rows = findCarryOver(
                projectId, bindingId, ruleName,
                QuarantineAcknowledgment.sha256Hex(reason),
                csvMtimeMs, csvSize, allowedPhases);
        return rows.isEmpty() ? Optional.empty() : Optional.of(rows.get(0));
    }

    /**
     * 명시 ack lookup — fingerprint 무관 (csv_mtime_ms / csv_size 불일치 / null 이어도 매칭).
     * "이 group 에 명시 ack 가 1건이라도 있나?" 판정용. listGroups / Validation status 양쪽 사용.
     */
    @Query("""
        SELECT a FROM QuarantineAcknowledgment a
         WHERE a.projectId  = :projectId
           AND a.bindingId  = :bindingId
           AND a.ruleName   = :ruleName
           AND a.reasonHash = :reasonHash
           AND a.phase IN :allowedPhases
         ORDER BY a.acknowledgedAt DESC
        """)
    List<QuarantineAcknowledgment> findExplicit(@Param("projectId") String projectId,
                                                @Param("bindingId") String bindingId,
                                                @Param("ruleName")  String ruleName,
                                                @Param("reasonHash") String reasonHash,
                                                @Param("allowedPhases") List<String> allowedPhases);

    default Optional<QuarantineAcknowledgment> findLatestExplicit(String projectId, String bindingId,
                                                                  String ruleName, String reason,
                                                                  List<String> allowedPhases) {
        List<QuarantineAcknowledgment> rows = findExplicit(
                projectId, bindingId, ruleName,
                QuarantineAcknowledgment.sha256Hex(reason), allowedPhases);
        return rows.isEmpty() ? Optional.empty() : Optional.of(rows.get(0));
    }

    /** 한 project 의 모든 ack (Versions / Dashboard 표시용). */
    List<QuarantineAcknowledgment> findByProjectIdOrderByAcknowledgedAtDesc(String projectId);

    /** 한 binding 의 ack 목록. */
    List<QuarantineAcknowledgment> findByBindingIdOrderByAcknowledgedAtDesc(String bindingId);

    /**
     * Group 별 ack 전체 이력 — LogViewer 의 (↗ history) popover 표시용.
     * 같은 (project, binding, rule_name, reason) 의 모든 ack 를 phase 무관 시간 역순으로.
     * Phase 가 다른 ack 도 함께 표시 (cross-phase carry-over 추적).
     */
    @Query("""
        SELECT a FROM QuarantineAcknowledgment a
         WHERE a.projectId  = :projectId
           AND a.bindingId  = :bindingId
           AND a.ruleName   = :ruleName
           AND a.reasonHash = :reasonHash
         ORDER BY a.acknowledgedAt DESC
        """)
    List<QuarantineAcknowledgment> findHistoryByGroup(@Param("projectId") String projectId,
                                                      @Param("bindingId") String bindingId,
                                                      @Param("ruleName")  String ruleName,
                                                      @Param("reasonHash") String reasonHash);
}

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
     */
    @Query("""
        SELECT a FROM QuarantineAcknowledgment a
         WHERE a.projectId = :projectId
           AND a.bindingId = :bindingId
           AND a.ruleName  = :ruleName
           AND a.reason    = :reason
           AND a.csvMtimeMs = :csvMtimeMs
           AND a.csvSize    = :csvSize
           AND a.phase IN :allowedPhases
         ORDER BY a.acknowledgedAt DESC
        """)
    List<QuarantineAcknowledgment> findCarryOver(@Param("projectId") String projectId,
                                                 @Param("bindingId") String bindingId,
                                                 @Param("ruleName")  String ruleName,
                                                 @Param("reason")    String reason,
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
                projectId, bindingId, ruleName, reason, csvMtimeMs, csvSize, allowedPhases);
        return rows.isEmpty() ? Optional.empty() : Optional.of(rows.get(0));
    }

    /** 한 project 의 모든 ack (Versions / Dashboard 표시용). */
    List<QuarantineAcknowledgment> findByProjectIdOrderByAcknowledgedAtDesc(String projectId);

    /** 한 binding 의 ack 목록. */
    List<QuarantineAcknowledgment> findByBindingIdOrderByAcknowledgedAtDesc(String bindingId);
}

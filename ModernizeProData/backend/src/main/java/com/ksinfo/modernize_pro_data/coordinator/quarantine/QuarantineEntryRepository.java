package com.ksinfo.modernize_pro_data.coordinator.quarantine;

import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;

public interface QuarantineEntryRepository extends JpaRepository<QuarantineEntry, String> {

    List<QuarantineEntry> findByRunIdOrderByCreatedAtAsc(String runId);

    List<QuarantineEntry> findByRunIdInOrderByCreatedAtAsc(List<String> runIds);

    /** run 의 severity 별 quarantine 건수 (execution overview 의 error/warning 카운트용). */
    long countByRunIdAndSeverity(String runId, QuarantineSeverity severity);

    /**
     * 한 (stage, binding) 의 quarantine entry — Validation stage 가 binding 별 WARN/FAIL
     * 카운트 분기 (success / failed / failed_with_pending_warnings) 결정용.
     */
    List<QuarantineEntry> findByStageInstanceIdAndBindingIdOrderByCreatedAtAsc(
            String stageInstanceId, String bindingId);
}

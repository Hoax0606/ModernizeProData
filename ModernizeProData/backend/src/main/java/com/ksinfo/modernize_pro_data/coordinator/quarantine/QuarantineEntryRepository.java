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

    /**
     * Archive panel 용 — 같은 (binding_id, rule_name) 의 **시간상 이전** entry.
     * 현재 entry 의 createdAt 보다 옛 row 만. runId 도 자기 자신 제외.
     * "최신 카드 = 현재", "archive = 그 이전 발생 이력" 의 시간 의미 보장.
     * QuarantineController 가 toGroupView 시점에 호출 → group 의 history field 채움.
     */
    List<QuarantineEntry> findByBindingIdAndRuleNameAndCreatedAtLessThanAndRunIdNotOrderByCreatedAtDesc(
            String bindingId, String ruleName, java.time.OffsetDateTime createdAt, String runId);
}

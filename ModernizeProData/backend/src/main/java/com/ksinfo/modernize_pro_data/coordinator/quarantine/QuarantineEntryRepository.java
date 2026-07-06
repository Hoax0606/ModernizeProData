package com.ksinfo.modernize_pro_data.coordinator.quarantine;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.util.List;

public interface QuarantineEntryRepository extends JpaRepository<QuarantineEntry, String> {

    List<QuarantineEntry> findByRunIdOrderByCreatedAtAsc(String runId);

    List<QuarantineEntry> findByRunIdInOrderByCreatedAtAsc(List<String> runIds);

    /** run 의 severity 별 quarantine 건수 (execution overview 의 error/warning 카운트용). */
    long countByRunIdAndSeverity(String runId, QuarantineSeverity severity);

    /**
     * Execution overview 의 warningAckedCount 계산용 — WARN entry 를 통째로 로드(JSONB hydration)
     * 하지 않고, ack 매칭에 필요한 group key (binding_id, rule_name, reason) + 건수만 집계.
     * 5초 polling × N project × M browser 의 heap churn 을 없앤다 (2026-06-10 OOM 완화).
     *
     * reason 은 sample_data JSONB 의 'reason' (없으면 ''). 기존 in-memory grouping key 와 동일.
     */
    @Query(value = "SELECT binding_id AS bindingId, rule_name AS ruleName, "
            + "COALESCE(sample_data->>'reason', '') AS reason, count(*) AS cnt "
            + "FROM quarantine_entries WHERE run_id = :runId AND severity = 'warning' "
            + "GROUP BY binding_id, rule_name, COALESCE(sample_data->>'reason', '')",
            nativeQuery = true)
    List<WarnGroupCount> warnGroupsByRun(@Param("runId") String runId);

    /** {@link #warnGroupsByRun} projection — alias 매핑. */
    interface WarnGroupCount {
        String getBindingId();
        String getRuleName();
        String getReason();
        long getCnt();
    }

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

package com.ksinfo.modernize_pro_data.coordinator.quarantine;

import com.ksinfo.modernize_pro_data.coordinator.run.RunType;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;
import java.util.Optional;

/**
 * 운영자의 WARN 그룹 ack 워크플로우.
 *
 * Scope = per-stageLabel (rule_name + binding_id + reason). 같은 fingerprint 의 모든
 * WARN row 가 한 ack 로 처리됨.
 *
 * Carry-over (옵션 C — 조건부):
 *   같은 (project, binding, rule_name, reason, csv_mtime_ms, csv_size, phase) 매칭 시
 *   다음 run 에 자동 적용.
 *
 * Phase 매칭 룰 (정책 7):
 *   - test      → ack.phase IN (test)
 *   - rehearsal → ack.phase IN (rehearsal)
 *   - cutover   → ack.phase IN (rehearsal, cutover)
 */
@Service
@RequiredArgsConstructor
@Slf4j
public class QuarantineAckService {

    private final QuarantineAcknowledgmentRepository ackRepo;

    /** 운영자가 WARN 그룹 명시 ack — group view 에서 [Acknowledge group] 클릭. */
    @Transactional
    public QuarantineAcknowledgment acknowledge(String projectId, String bindingId,
                                                String ruleName, String reason,
                                                Long csvMtimeMs, Long csvSize,
                                                RunType phase, String acknowledgedBy,
                                                String note) {
        QuarantineAcknowledgment ack = QuarantineAcknowledgment.create(
                projectId, bindingId, ruleName, reason,
                csvMtimeMs, csvSize, phase.name(), acknowledgedBy, note);
        log.info("quarantine ack project={} binding={} rule={} reason={} phase={} by={}",
                projectId, bindingId, ruleName, reason, phase, acknowledgedBy);
        return ackRepo.save(ack);
    }

    /**
     * Carry-over 조회 — 같은 fingerprint 의 ack 가 있으면 자동 적용.
     * csv_mtime_ms / csv_size 둘 중 하나라도 null 이면 carry-over 미적용 (안전 우선).
     */
    @Transactional(readOnly = true)
    public Optional<QuarantineAcknowledgment> findCarryOver(String projectId, String bindingId,
                                                            String ruleName, String reason,
                                                            Long csvMtimeMs, Long csvSize,
                                                            RunType currentPhase) {
        if (csvMtimeMs == null || csvSize == null) return Optional.empty();
        List<String> allowedPhases = allowedPhasesForLookup(currentPhase);
        return ackRepo.findLatestCarryOver(projectId, bindingId, ruleName, reason,
                                            csvMtimeMs, csvSize, allowedPhases);
    }

    /** carry-over 가능한 ack 의 phase 후보 — 정책 7. */
    public static List<String> allowedPhasesForLookup(RunType currentPhase) {
        return switch (currentPhase) {
            case test       -> List.of(RunType.test.name());
            case rehearsal  -> List.of(RunType.rehearsal.name());
            case cutover    -> List.of(RunType.rehearsal.name(), RunType.cutover.name());
        };
    }

    /** Project 단위 ack 목록 — Versions / Dashboard 표시용. */
    @Transactional(readOnly = true)
    public List<QuarantineAcknowledgment> listByProject(String projectId) {
        return ackRepo.findByProjectIdOrderByAcknowledgedAtDesc(projectId);
    }
}

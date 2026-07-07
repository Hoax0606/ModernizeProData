package com.ksinfo.modernize_pro_data.coordinator.quarantine;

import com.ksinfo.modernize_pro_data.common.exception.ApiException;
import com.ksinfo.modernize_pro_data.coordinator.run.RunType;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.http.HttpStatus;
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

    /**
     * 운영자가 WARN 그룹 명시 ack — group view 에서 [Acknowledge group] 클릭.
     *
     * 중복 ack: DB 의 ux_qack_dedup UNIQUE constraint 가 같은 (project, binding, rule,
     * reason_hash, phase, fingerprint) 조합을 거부 → 409 Conflict 변환.
     */
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
        try {
            return ackRepo.save(ack);
        } catch (DataIntegrityViolationException e) {
            throw new ApiException("ACK_DUPLICATE",
                    "Already acknowledged", HttpStatus.CONFLICT);
        }
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

    /**
     * 명시 ack lookup — fingerprint 무관. listGroups 의 "ack 됐나?" 판정과
     * Validation status (WARN 만 + ack 있음 → success) 양쪽 사용.
     *
     * carry-over 와의 차이:
     *   - findCarryOver: fingerprint 일치 + 보호적 (다음 run 자동 적용)
     *   - findExplicitAck: 명시 ack 가 1건이라도 있나 — UI/판정 표시용
     */
    @Transactional(readOnly = true)
    public Optional<QuarantineAcknowledgment> findExplicitAck(String projectId, String bindingId,
                                                              String ruleName, String reason,
                                                              RunType currentPhase) {
        List<String> allowedPhases = allowedPhasesForLookup(currentPhase);
        return ackRepo.findLatestExplicit(projectId, bindingId, ruleName, reason, allowedPhases);
    }

    /**
     * Group key (binding + rule_name + reason) 의 explicit ack 총 개수 — fingerprint·phase 무관.
     * FE 의 "이전 ack 있음" hint 트리거용 (다른 CSV/phase 의 ack 까지 카운트).
     */
    @Transactional(readOnly = true)
    public int countExplicitAckByGroup(String projectId, String bindingId,
                                       String ruleName, String reason) {
        return ackRepo.findHistoryByGroup(projectId, bindingId, ruleName,
                QuarantineAcknowledgment.sha256Hex(reason)).size();
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

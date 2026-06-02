package com.ksinfo.modernize_pro_data.coordinator.api;

import com.ksinfo.modernize_pro_data.common.dto.ApiResponse;
import com.ksinfo.modernize_pro_data.common.exception.ApiException;
import com.ksinfo.modernize_pro_data.coordinator.quarantine.QuarantineAckService;
import com.ksinfo.modernize_pro_data.coordinator.quarantine.QuarantineAcknowledgment;
import com.ksinfo.modernize_pro_data.coordinator.quarantine.QuarantineAcknowledgmentRepository;
import com.ksinfo.modernize_pro_data.coordinator.quarantine.QuarantineEntry;
import com.ksinfo.modernize_pro_data.coordinator.quarantine.QuarantineEntryRepository;
import com.ksinfo.modernize_pro_data.coordinator.quarantine.QuarantineSeverity;
import com.ksinfo.modernize_pro_data.coordinator.run.RunHistory;
import com.ksinfo.modernize_pro_data.coordinator.run.RunHistoryRepository;
import com.ksinfo.modernize_pro_data.coordinator.run.RunType;
import com.ksinfo.modernize_pro_data.coordinator.run.stage.StageInstance;
import com.ksinfo.modernize_pro_data.coordinator.run.stage.StageInstanceRepository;
import com.ksinfo.modernize_pro_data.coordinator.site.Project;
import com.ksinfo.modernize_pro_data.coordinator.site.ProjectRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.HttpStatus;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.stream.Collectors;

/**
 * WARN ack 시스템 REST endpoints (2026-06-01).
 *
 * 정책:
 *   1. WARN 만 있어도 차단 — Request Review / Approve / Cutover 게이트
 *   2. Scope = per-stageLabel (rule_name + binding_id + reason)
 *   3. Carry-over = fingerprint 기반 (csv_mtime_ms + csv_size 일치 + phase 매칭)
 *   4. Cutover = rehearsal default 채택 + 최종 확인 (분류 quick review)
 */
@RestController
@RequiredArgsConstructor
@Slf4j
public class QuarantineAckController {

    private final QuarantineAckService ackService;
    private final QuarantineAcknowledgmentRepository ackRepo;
    private final QuarantineEntryRepository quarantineEntryRepo;
    private final RunHistoryRepository runRepo;
    private final ProjectRepository projectRepo;
    private final StageInstanceRepository stageRepo;

    /**
     * 운영자가 WARN 그룹 명시 ack — group view 의 [Acknowledge group] 버튼.
     * Scope = per (project + binding + rule_name + reason + phase).
     */
    @PostMapping("/api/v1/quarantine/acknowledge")
    @PreAuthorize("hasAnyRole('MASTER','ADMIN','OPERATOR')")
    public ApiResponse<AckResponse> acknowledge(@RequestBody AckRequest req, Authentication auth) {
        if (req.projectId() == null || req.projectId().isBlank()
                || req.bindingId() == null || req.bindingId().isBlank()
                || req.ruleName() == null || req.ruleName().isBlank()
                || req.reason() == null
                || req.phase() == null) {
            throw new ApiException("ACK_INVALID",
                    "projectId/bindingId/ruleName/reason/phase required",
                    HttpStatus.BAD_REQUEST);
        }
        RunType phase;
        try {
            phase = RunType.valueOf(req.phase());
        } catch (IllegalArgumentException e) {
            throw new ApiException("ACK_PHASE_INVALID",
                    "phase must be one of test/rehearsal/cutover",
                    HttpStatus.BAD_REQUEST);
        }
        String username = auth == null ? "unknown" : auth.getName();
        QuarantineAcknowledgment saved = ackService.acknowledge(
                req.projectId(), req.bindingId(), req.ruleName(), req.reason(),
                req.csvMtimeMs(), req.csvSize(), phase, username, req.note());
        return ApiResponse.ok(new AckResponse(
                saved.getId(), saved.getAcknowledgedBy(), saved.getAcknowledgedAt(),
                saved.getPhase()));
    }

    /**
     * Run 의 quarantine entry 들을 group (rule_name + binding + reason) 단위로 묶음 + ack 상태.
     * FE Quarantine 페이지의 group view backend.
     */
    @GetMapping("/api/v1/runs/{runId}/quarantine-groups")
    @PreAuthorize("hasAnyRole('MASTER','ADMIN','OPERATOR','VIEWER')")
    public ApiResponse<List<QuarantineGroupAckView>> listGroups(@PathVariable String runId) {
        RunHistory run = runRepo.findById(runId)
                .orElseThrow(() -> new ApiException("RUN_NOT_FOUND",
                        "Run not found: " + runId, HttpStatus.NOT_FOUND));
        Project project = projectRepo.findById(run.getProjectId())
                .orElseThrow(() -> new ApiException("PROJECT_NOT_FOUND",
                        "Project not found: " + run.getProjectId(), HttpStatus.NOT_FOUND));

        List<QuarantineEntry> entries = quarantineEntryRepo.findByRunIdOrderByCreatedAtAsc(runId);
        if (entries.isEmpty()) return ApiResponse.ok(List.of());

        Map<String, String> stageKeyById = loadStageKeys(entries);

        // group key = bindingId + ruleName + reason
        Map<String, GroupAggregator> groups = new LinkedHashMap<>();
        for (QuarantineEntry e : entries) {
            Map<String, Object> sample = e.getSampleData() == null ? Map.of() : e.getSampleData();
            String reason = String.valueOf(sample.getOrDefault("reason", ""));
            String key = e.getBindingId() + "|" + e.getRuleName() + "|" + reason;
            Long cMtime = sample.get("csvMtimeMs") instanceof Number nm ? nm.longValue() : null;
            Long cSize  = sample.get("csvSize")    instanceof Number ns ? ns.longValue() : null;
            GroupAggregator g = groups.computeIfAbsent(key, k -> new GroupAggregator(
                    e.getBindingId(), e.getRuleName(), reason,
                    String.valueOf(sample.getOrDefault("table", "")),
                    String.valueOf(sample.getOrDefault("stageLabel",
                            stageKeyById.getOrDefault(e.getStageInstanceId(), "unknown"))),
                    e.getSeverity(), cMtime, cSize));
            g.rowCount += (e.getRowCount() == null ? 0 : e.getRowCount());
            g.entryCount++;
        }

        // 각 group 별 ack lookup — carry-over 정책 (정책 3·6): fingerprint 일치 + phase 매칭일 때만.
        // fingerprint null (첫 도입 / 미측정) 이면 carry-over 비활성. FE 는 ack 존재 시 dim+meta 표시.
        List<String> allowedPhases = QuarantineAckService.allowedPhasesForLookup(run.getRunType());
        List<QuarantineGroupAckView> result = new ArrayList<>(groups.size());
        for (GroupAggregator g : groups.values()) {
            Optional<QuarantineAcknowledgment> carryOver = ackRepo.findLatestCarryOver(
                    project.getId(), g.bindingId, g.ruleName, g.reason,
                    g.csvMtimeMs, g.csvSize, allowedPhases);
            AckInfo ackInfo = carryOver.map(a -> new AckInfo(
                    a.getId(), a.getAcknowledgedBy(), a.getAcknowledgedAt(),
                    a.getPhase(), !a.getPhase().equals(run.getRunType().name()))).orElse(null);
            result.add(new QuarantineGroupAckView(
                    g.bindingId, g.tableName, g.ruleName, g.reason, g.stageLabel,
                    g.severity.name(), g.rowCount, g.entryCount, ackInfo));
        }
        return ApiResponse.ok(result);
    }

    /**
     * Cutover 최종 확인 (정책 4) — rehearsal ack default 채택 + 운영자 동의.
     * 분류 quick review: 운영자가 group 별로 confirm/reject. confirmed group 은 cutover phase 의
     * ack 로 추가 저장 (rehearsal ack 와 별도).
     */
    @PostMapping("/api/v1/runs/{runId}/cutover-review/confirm")
    @PreAuthorize("hasAnyRole('MASTER','ADMIN','OPERATOR')")
    public ApiResponse<CutoverReviewResponse> confirmCutoverReview(@PathVariable String runId,
                                                                    @RequestBody CutoverReviewRequest req,
                                                                    Authentication auth) {
        RunHistory run = runRepo.findById(runId)
                .orElseThrow(() -> new ApiException("RUN_NOT_FOUND",
                        "Run not found: " + runId, HttpStatus.NOT_FOUND));
        if (run.getRunType() != RunType.cutover) {
            throw new ApiException("RUN_NOT_CUTOVER",
                    "Cutover review only for cutover run", HttpStatus.BAD_REQUEST);
        }
        String username = auth == null ? "unknown" : auth.getName();
        String projectId = run.getProjectId();

        int confirmedCount = 0;
        int rejectedCount = 0;
        for (CutoverReviewGroup g : req.groups()) {
            if (g.confirmed()) {
                ackService.acknowledge(projectId, g.bindingId(), g.ruleName(), g.reason(),
                        g.csvMtimeMs(), g.csvSize(), RunType.cutover, username,
                        "[cutover-review] " + (req.note() == null ? "" : req.note()));
                confirmedCount++;
            } else {
                rejectedCount++;
            }
        }
        log.info("cutover review run={} confirmed={} rejected={} by={}",
                runId, confirmedCount, rejectedCount, username);
        return ApiResponse.ok(new CutoverReviewResponse(confirmedCount, rejectedCount));
    }

    /**
     * Group 별 ack history — LogViewer 의 (↗ history) popover.
     * 같은 (project, binding, rule_name, reason) 의 모든 ack 이력 (phase 무관 시간 역순).
     */
    @GetMapping("/api/v1/quarantine/ack-history")
    @PreAuthorize("hasAnyRole('MASTER','ADMIN','OPERATOR','VIEWER')")
    public ApiResponse<List<AckHistoryEntry>> ackHistory(
            @org.springframework.web.bind.annotation.RequestParam String projectId,
            @org.springframework.web.bind.annotation.RequestParam String bindingId,
            @org.springframework.web.bind.annotation.RequestParam String ruleName,
            @org.springframework.web.bind.annotation.RequestParam String reason) {
        if (projectId == null || projectId.isBlank()
                || bindingId == null || bindingId.isBlank()
                || ruleName == null || ruleName.isBlank()
                || reason == null) {
            throw new ApiException("ACK_HISTORY_INVALID",
                    "projectId/bindingId/ruleName/reason required", HttpStatus.BAD_REQUEST);
        }
        String reasonHash = QuarantineAcknowledgment.sha256Hex(reason);
        List<QuarantineAcknowledgment> rows = ackRepo.findHistoryByGroup(
                projectId, bindingId, ruleName, reasonHash);
        List<AckHistoryEntry> result = rows.stream()
                .map(a -> new AckHistoryEntry(
                        a.getId(), a.getAcknowledgedBy(), a.getAcknowledgedAt(),
                        a.getPhase(), a.getCsvMtimeMs(), a.getCsvSize(), a.getNote()))
                .toList();
        return ApiResponse.ok(result);
    }

    /* ─────────────────────── helpers ─────────────────────── */

    private Map<String, String> loadStageKeys(List<QuarantineEntry> entries) {
        List<String> stageIds = entries.stream()
                .map(QuarantineEntry::getStageInstanceId).distinct().toList();
        return stageRepo.findAllById(stageIds).stream()
                .collect(Collectors.toMap(StageInstance::getId, StageInstance::getStageKey));
    }

    /* ─────────────────────── DTOs ───────────────────────── */

    public record AckRequest(
            String projectId,
            String bindingId,
            String ruleName,
            String reason,
            Long csvMtimeMs,         // optional — carry-over 매칭용
            Long csvSize,            // optional — carry-over 매칭용
            String phase,            // test / rehearsal / cutover
            String note              // optional
    ) {}

    public record AckResponse(
            Long acknowledgmentId,
            String acknowledgedBy,
            OffsetDateTime acknowledgedAt,
            String phase
    ) {}

    public record AckInfo(
            Long acknowledgmentId,
            String acknowledgedBy,
            OffsetDateTime acknowledgedAt,
            String phase,
            boolean carryOver         // true = 이전 phase 의 ack 가 자동 적용
    ) {}

    public record QuarantineGroupAckView(
            String bindingId,
            String tableName,
            String ruleName,
            String reason,
            String stageLabel,        // "validate.checksum" etc.
            String severity,          // error / warning
            long rowCount,            // 그룹 내 총 row 수
            int entryCount,           // entry (quarantine row) 수
            AckInfo ack               // null = ack 없음
    ) {}

    public record CutoverReviewRequest(
            List<CutoverReviewGroup> groups,
            String note               // optional 운영자 메모
    ) {}

    public record CutoverReviewGroup(
            String bindingId,
            String ruleName,
            String reason,
            Long csvMtimeMs,
            Long csvSize,
            boolean confirmed         // true = ack, false = reject (별도 워크플로우)
    ) {}

    public record CutoverReviewResponse(
            int confirmedCount,
            int rejectedCount
    ) {}

    public record AckHistoryEntry(
            Long acknowledgmentId,
            String acknowledgedBy,
            OffsetDateTime acknowledgedAt,
            String phase,                  // test / rehearsal / cutover
            Long csvMtimeMs,               // null = 첫 적용 (fingerprint 미측정)
            Long csvSize,
            String note                    // 운영자 메모 (선택)
    ) {}

    /* group 집계용 — DTO 만들기 전 단계. */
    private static class GroupAggregator {
        final String bindingId;
        final String ruleName;
        final String reason;
        final String tableName;
        final String stageLabel;
        final QuarantineSeverity severity;
        final Long csvMtimeMs;     // carry-over fingerprint (정책 3·6) — sample_data 에서 추출
        final Long csvSize;
        long rowCount = 0;
        int entryCount = 0;

        GroupAggregator(String bindingId, String ruleName, String reason,
                        String tableName, String stageLabel, QuarantineSeverity severity,
                        Long csvMtimeMs, Long csvSize) {
            this.bindingId = bindingId;
            this.ruleName = ruleName;
            this.reason = reason;
            this.tableName = tableName;
            this.stageLabel = stageLabel;
            this.severity = severity;
            this.csvMtimeMs = csvMtimeMs;
            this.csvSize = csvSize;
        }
    }
}

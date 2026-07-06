package com.ksinfo.modernize_pro_data.coordinator.api;

import com.ksinfo.modernize_pro_data.common.dto.ApiResponse;
import com.ksinfo.modernize_pro_data.common.exception.ApiException;
import com.ksinfo.modernize_pro_data.coordinator.quarantine.QuarantineAckService;
import com.ksinfo.modernize_pro_data.coordinator.quarantine.QuarantineAcknowledgment;
import com.ksinfo.modernize_pro_data.coordinator.quarantine.QuarantineEntry;
import com.ksinfo.modernize_pro_data.coordinator.quarantine.QuarantineEntryRepository;
import com.ksinfo.modernize_pro_data.coordinator.run.RunHistory;
import com.ksinfo.modernize_pro_data.coordinator.run.RunHistoryRepository;
import com.ksinfo.modernize_pro_data.coordinator.run.RunType;
import com.ksinfo.modernize_pro_data.coordinator.run.stage.StageInstance;
import com.ksinfo.modernize_pro_data.coordinator.run.stage.StageInstanceRepository;
import com.ksinfo.modernize_pro_data.coordinator.run.stage.StageTableResult;
import com.ksinfo.modernize_pro_data.coordinator.run.stage.StageTableResultRepository;
import com.ksinfo.modernize_pro_data.coordinator.site.Project;
import com.ksinfo.modernize_pro_data.coordinator.site.ProjectRepository;
import lombok.RequiredArgsConstructor;
import org.springframework.core.io.FileSystemResource;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RestController;

import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.stream.Collectors;

/**
 * Quarantine read-only endpoints.
 *
 * Frontend 의 QuarantineGroup / SiteQuarantineGroup interface 와 1:1 매칭.
 * `sample_data` JSONB 안에 columns / columnRoles / sampleRows / toBeValues / reason / detail
 * / table / stageLabel 가 frontend shape 그대로 저장되어 있음. 여기서는 그걸 풀어내서
 * flat DTO 로 전달.
 */
@RestController
@RequiredArgsConstructor
public class QuarantineController {

    private final QuarantineEntryRepository quarantineRepo;
    private final StageInstanceRepository stageRepo;
    private final StageTableResultRepository stageTableResultRepo;
    private final RunHistoryRepository runRepo;
    private final ProjectRepository projectRepo;
    private final QuarantineAckService ackService;

    /**
     * Run 1 회분의 quarantine group. LogViewerPage 의 quarantine 탭.
     *
     * 각 entry 에 명시 ack 정보 매핑 — 같은 (binding, rule_name, reason) 의 ack 가 있으면
     * group 카드에 "이미 검토 완료" 표시 (FE LogViewerPage 의 Acknowledge 버튼 비활성).
     */
    @GetMapping("/api/v1/runs/{runId}/quarantine")
    public ApiResponse<List<QuarantineGroupView>> listByRun(@PathVariable String runId) {
        List<QuarantineEntry> entries = quarantineRepo.findByRunIdOrderByCreatedAtAsc(runId);
        if (entries.isEmpty()) return ApiResponse.ok(List.of());

        Map<String, String> stageKeyById = loadStageKeys(entries);

        // ack lookup — entry 별로 매번 호출하면 N+1. unique (binding, rule, reason) 만 lookup.
        RunHistory run = runRepo.findById(runId).orElse(null);
        Map<String, AckSummary> ackByKey = run == null
                ? Map.of()
                : loadAckSummaryByGroup(entries, run.getProjectId(), run.getRunType());

        return ApiResponse.ok(entries.stream()
                .map(e -> {
                    Map<String, Object> s = e.getSampleData() == null ? Map.of() : e.getSampleData();
                    String reason = (String) s.getOrDefault("reason", e.getRuleName());
                    String ackKey = e.getBindingId() + "|" + e.getRuleName() + "|" + reason;
                    AckSummary summary = ackByKey.get(ackKey);
                    AckInfoView ack = summary == null ? null : summary.ack();
                    int priorCount = summary == null ? 0 : summary.priorAckCount();
                    return toGroupView(e, stageKeyById.getOrDefault(e.getStageInstanceId(), "unknown"), ack, priorCount);
                })
                .toList());
    }

    /**
     * Entries 의 unique (binding, rule, reason) set 을 만들고 각각 ack 상태 lookup.
     * 두 정보 동시 채움:
     *   - ack (carry-over): fingerprint+phase 일치 시. dim+meta 표시 트리거.
     *   - priorAckCount: fingerprint 무관 같은 group key 의 explicit ack 총 개수.
     *     ack==null + priorAckCount > 0 = "다른 CSV 의 ack 만 있음" → FE 가 hint 표시.
     */
    private Map<String, AckSummary> loadAckSummaryByGroup(List<QuarantineEntry> entries,
                                                          String projectId, RunType phase) {
        Set<String> seen = new LinkedHashSet<>();
        Map<String, AckSummary> out = new HashMap<>();
        for (QuarantineEntry e : entries) {
            Map<String, Object> s = e.getSampleData() == null ? Map.of() : e.getSampleData();
            String reason = (String) s.getOrDefault("reason", e.getRuleName());
            String key = e.getBindingId() + "|" + e.getRuleName() + "|" + reason;
            if (!seen.add(key)) continue;
            // Carry-over (정책 3·6): fingerprint 일치 시에만.
            Long mtime = s.get("csvMtimeMs") instanceof Number n  ? n.longValue()  : null;
            Long size  = s.get("csvSize")    instanceof Number n2 ? n2.longValue() : null;
            Optional<QuarantineAcknowledgment> carryAck = ackService.findCarryOver(
                    projectId, e.getBindingId(), e.getRuleName(), reason, mtime, size, phase);
            AckInfoView ackView = carryAck.map(a -> new AckInfoView(
                    a.getId(), a.getAcknowledgedBy(), a.getAcknowledgedAt(), a.getPhase()))
                    .orElse(null);
            // Prior ack count (fingerprint 무관) — 같은 group 의 explicit ack 전체 이력 길이.
            int priorCount = ackService.countExplicitAckByGroup(
                    projectId, e.getBindingId(), e.getRuleName(), reason);
            out.put(key, new AckSummary(ackView, priorCount));
        }
        return out;
    }

    /** group 별 ack 요약 — carry-over ack (있을 수 있음) + 같은 group 전체 ack count. */
    private record AckSummary(AckInfoView ack, int priorAckCount) {}

    /**
     * Site 단위 — 모든 project 의 최근 run 의 quarantine.
     * "최근 run" = run_history.started_at desc 1건. SiteQuarantinePage 가 호출.
     */
    @GetMapping("/api/v1/sites/{siteId}/quarantine")
    public ApiResponse<List<SiteQuarantineGroupView>> listBySite(@PathVariable String siteId) {
        List<Project> projects = projectRepo.findBySiteId(siteId);
        if (projects.isEmpty()) return ApiResponse.ok(List.of());

        List<SiteQuarantineGroupView> result = new ArrayList<>();
        for (Project p : projects) {
            List<RunHistory> runs = runRepo.findByProjectIdOrderByStartedAtDesc(p.getId());
            if (runs.isEmpty()) continue;

            // quarantine 가 있는 "가장 최근 run" 을 anchor 로 한다. 최신 run 이 비어있으면
            // (새 run 이 막 시작됐거나 clean run) → 직전 run 의 quarantine 을 보여주되, 그게 더 이상
            // 최신 run 이 아니므로 fromLatestRun=false 로 표시 → FE 가 "지난 Run" 으로 마킹(B 방식).
            RunHistory srcRun = null;
            List<QuarantineEntry> entries = List.of();
            for (RunHistory r : runs) {
                List<QuarantineEntry> es = quarantineRepo.findByRunIdOrderByCreatedAtAsc(r.getId());
                if (!es.isEmpty()) { srcRun = r; entries = es; break; }
            }
            if (srcRun == null) continue;
            boolean fromLatestRun = runs.get(0).getId().equals(srcRun.getId());

            Map<String, String> stageKeyById = loadStageKeys(entries);
            // Site-wide 뷰도 ack(skip) 상태를 표시 — per-project 에서 Skip 한 WARN 이 여기서도
            // skip 으로 보이게 (직접 ack 는 안 하고 상태만 반영). byRun 과 동일한 carry-over 규칙.
            Map<String, AckSummary> ackByKey = loadAckSummaryByGroup(entries, p.getId(), srcRun.getRunType());
            for (QuarantineEntry e : entries) {
                String stage = stageKeyById.getOrDefault(e.getStageInstanceId(), "unknown");
                Map<String, Object> s = e.getSampleData() == null ? Map.of() : e.getSampleData();
                String reason = (String) s.getOrDefault("reason", e.getRuleName());
                AckSummary summary = ackByKey.get(e.getBindingId() + "|" + e.getRuleName() + "|" + reason);
                AckInfoView ack = summary == null ? null : summary.ack();
                int priorCount = summary == null ? 0 : summary.priorAckCount();
                QuarantineGroupView g = toGroupView(e, stage, ack, priorCount);
                result.add(new SiteQuarantineGroupView(
                        g.id(), g.runId(), g.bindingId(), g.reason(), g.detail(), g.severity(), g.stage(),
                        g.firstSeenAt(), g.table(),
                        g.columns(), g.columnRoles(), g.sampleRows(), g.toBeValues(),
                        g.rowCount(),
                        p.getId(), p.getName(),
                        g.ack(),
                        fromLatestRun,
                        g.history()));
            }
        }
        return ApiResponse.ok(result);
    }

    /**
     * 위반 row 전수 parquet 다운로드. AuditStage 가 분리 시 저장한 파일을 stream.
     * 경로는 StageTableResult.errorDetail.quarantineParquet 에 저장돼 있다.
     * 같은 binding 의 모든 위반(NOT NULL gender + birth_date 등) 이 한 파일에 합쳐져있다.
     */
    @GetMapping("/api/v1/runs/{runId}/quarantine/{bindingId}/download")
    public ResponseEntity<FileSystemResource> downloadBindingParquet(@PathVariable String runId,
                                                                     @PathVariable String bindingId) {
        // audit stage instance 찾기 — 일반적으로 stageKey='audit'.
        StageInstance auditStage = stageRepo.findByRunIdAndStageKey(runId, "audit")
                .orElseThrow(() -> new ApiException("AUDIT_STAGE_NOT_FOUND",
                        "Audit stage not found for run: " + runId, HttpStatus.NOT_FOUND));

        StageTableResult result = stageTableResultRepo
                .findByStageInstanceIdAndBindingId(auditStage.getId(), bindingId)
                .orElseThrow(() -> new ApiException("QUARANTINE_NOT_FOUND",
                        "No audit result for binding: " + bindingId, HttpStatus.NOT_FOUND));

        Map<String, Object> detail = result.getErrorDetail();
        Object pathStr = detail == null ? null : detail.get("quarantineParquet");
        if (!(pathStr instanceof String s) || s.isBlank()) {
            throw new ApiException("QUARANTINE_FILE_MISSING",
                    "No quarantine file recorded (no violations or pre-fix run)",
                    HttpStatus.NOT_FOUND);
        }
        Path file = Paths.get(s);
        if (!Files.exists(file)) {
            throw new ApiException("QUARANTINE_FILE_GONE",
                    "Quarantine file referenced but no longer on disk: " + file,
                    HttpStatus.NOT_FOUND);
        }
        String filename = file.getFileName().toString();
        return ResponseEntity.ok()
                .header(HttpHeaders.CONTENT_DISPOSITION, "attachment; filename=\"" + filename + "\"")
                .contentType(MediaType.APPLICATION_OCTET_STREAM)
                .body(new FileSystemResource(file));
    }

    /* ─────────────────────── helpers ─────────────────────── */

    private Map<String, String> loadStageKeys(List<QuarantineEntry> entries) {
        List<String> stageIds = entries.stream()
                .map(QuarantineEntry::getStageInstanceId).distinct().toList();
        return stageRepo.findAllById(stageIds).stream()
                .collect(Collectors.toMap(StageInstance::getId, StageInstance::getStageKey));
    }

    @SuppressWarnings("unchecked")
    private QuarantineGroupView toGroupView(QuarantineEntry e, String stageKeyFallback,
                                             AckInfoView ack, int priorAckCount) {
        Map<String, Object> s = e.getSampleData() == null ? Map.of() : e.getSampleData();
        String stageLabel = s.get("stageLabel") instanceof String sl ? sl : stageKeyFallback;
        Long csvMtimeMs = s.get("csvMtimeMs") instanceof Number n  ? n.longValue()  : null;
        Long csvSize    = s.get("csvSize")    instanceof Number n2 ? n2.longValue() : null;
        /* History — 같은 (binding, rule_name) 의 옛 run entry. 현재 run 제외, 최신순.
           각 entry 의 acked 상태는 그 run 의 explicit ack 가 있는지로 단순 판정 (carry-over 무관).
           N+1 회피: 한 entry 당 1 회 query. group 수 적으면 OK. group 수 많을 때 batch 화 향후. */
        List<HistoryEntryView> history = quarantineRepo
                .findByBindingIdAndRuleNameAndCreatedAtLessThanAndRunIdNotOrderByCreatedAtDesc(
                        e.getBindingId(), e.getRuleName(), e.getCreatedAt(), e.getRunId())
                .stream()
                .map(h -> {
                    Map<String, Object> hs = h.getSampleData() == null ? Map.of() : h.getSampleData();
                    String hReason = (String) hs.getOrDefault("reason", h.getRuleName());
                    /* 옛 run 의 runType 을 phase 로 사용 → findExplicitAck 의 정책 7 phase 매칭. */
                    RunHistory hRun = runRepo.findById(h.getRunId()).orElse(null);
                    Optional<QuarantineAcknowledgment> hAck = (hRun == null || hRun.getRunType() == null)
                            ? Optional.empty()
                            : ackService.findExplicitAck(hRun.getProjectId(), h.getBindingId(),
                                                         h.getRuleName(), hReason, hRun.getRunType());
                    @SuppressWarnings("unchecked")
                    List<String> hCols = (List<String>) hs.getOrDefault("columns", List.of());
                    @SuppressWarnings("unchecked")
                    List<String> hRoles = (List<String>) hs.getOrDefault("columnRoles", List.of());
                    @SuppressWarnings("unchecked")
                    List<List<Object>> hSample = (List<List<Object>>) hs.getOrDefault("sampleRows", List.of());
                    @SuppressWarnings("unchecked")
                    List<Object> hToBe = (List<Object>) hs.get("toBeValues");
                    return new HistoryEntryView(
                            h.getRunId(),
                            h.getCreatedAt(),
                            h.getRowCount() == null ? 0L : h.getRowCount(),
                            hAck.isPresent(),
                            hAck.map(QuarantineAcknowledgment::getAcknowledgedBy).orElse(null),
                            hAck.map(QuarantineAcknowledgment::getPhase).orElse(null),
                            hCols, hRoles, hSample, hToBe
                    );
                })
                .toList();
        return new QuarantineGroupView(
                e.getId(),
                e.getRunId(),
                e.getBindingId(),
                (String) s.getOrDefault("reason", e.getRuleName()),
                (String) s.getOrDefault("detail", ""),
                e.getSeverity().name(),
                stageLabel,
                e.getCreatedAt(),
                (String) s.getOrDefault("table", ""),
                (List<String>) s.getOrDefault("columns", List.of()),
                (List<String>) s.getOrDefault("columnRoles", List.of()),
                (List<List<Object>>) s.getOrDefault("sampleRows", List.of()),
                (List<Object>) s.get("toBeValues"),
                e.getRowCount() == null ? 0L : e.getRowCount(),
                csvMtimeMs, csvSize, ack, priorAckCount, history
        );
    }

    /* ──────────────────────── DTOs ───────────────────────── */

    public record QuarantineGroupView(
            String id,
            String runId,                     // 이 quarantine entry 가 속한 run
            String bindingId,                 // 다운로드 endpoint key — group 단위 parquet
            String reason,
            String detail,
            String severity,                  // error / warning
            String stage,                     // 세분화 라벨 (예: "validate.fk") or stage_key fallback
            OffsetDateTime firstSeenAt,
            String table,
            List<String> columns,
            List<String> columnRoles,
            List<List<Object>> sampleRows,
            List<Object> toBeValues,
            long rowCount,
            Long csvMtimeMs,                  // AS-IS CSV fingerprint — FE 가 ack 시 그대로 전송 (carry-over)
            Long csvSize,
            AckInfoView ack,                  // null = ack 없음. 같은 (binding, rule, reason) 의 carry-over ack
            int priorAckCount,                // fingerprint 무관 같은 group 의 explicit ack 총 개수. ack==null + priorAckCount>0 = 다른 CSV 의 ack 만 있음 → FE 가 hint 표시
            List<HistoryEntryView> history    // 같은 (binding, rule_name) 의 옛 run entry. FE archive panel 용
    ) {}

    /** Group ack 메타 — entry 가 속한 group 의 명시 ack 정보. FE 가 표시 + 버튼 disable 용. */
    public record AckInfoView(
            Long acknowledgmentId,
            String acknowledgedBy,
            OffsetDateTime acknowledgedAt,
            String phase                      // test / rehearsal / cutover
    ) {}

    /** 옛 run 의 quarantine entry summary — archive panel 용. FE QuarantineHistoryEntry 와 매칭.
     *  archive expand 시 그 옛 run 시점 의 진짜 sample 보여주기 위해 sample_data 도 unwrap. */
    public record HistoryEntryView(
            String runId,
            OffsetDateTime createdAt,
            long rowCount,
            boolean acked,                    // 같은 group key 의 explicit ack 있으면 true (단순화 — phase 별 정확 lookup 은 향후)
            String ackedBy,                   // ack 한 운영자. null 가능
            String ackedPhase,                // test / rehearsal / cutover. null 가능
            List<String> columns,             // 그 옛 entry 의 sample 표 헤더
            List<String> columnRoles,
            List<List<Object>> sampleRows,    // 그 옛 entry 의 sample rows (archive expand 표시)
            List<Object> toBeValues
    ) {}

    public record SiteQuarantineGroupView(
            String id,
            String runId,
            String bindingId,
            String reason,
            String detail,
            String severity,
            String stage,
            OffsetDateTime firstSeenAt,
            String table,
            List<String> columns,
            List<String> columnRoles,
            List<List<Object>> sampleRows,
            List<Object> toBeValues,
            long rowCount,
            String projectId,
            String projectName,
            AckInfoView ack,                  // null = ack 없음. per-project Skip(ack) 상태를 site 뷰에도 반영
            boolean fromLatestRun,            // false = 이 quarantine 은 프로젝트의 최신 run 이 아닌 직전 run 것 (새 run 시작됨) → FE 가 "지난 Run" 표시
            List<HistoryEntryView> history    // 같은 (binding, rule_name) 의 옛 run entry. FE archive panel 용
    ) {}
}

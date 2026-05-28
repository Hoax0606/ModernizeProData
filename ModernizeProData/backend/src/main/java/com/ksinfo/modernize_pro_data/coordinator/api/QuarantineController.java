package com.ksinfo.modernize_pro_data.coordinator.api;

import com.ksinfo.modernize_pro_data.common.dto.ApiResponse;
import com.ksinfo.modernize_pro_data.common.exception.ApiException;
import com.ksinfo.modernize_pro_data.coordinator.quarantine.QuarantineEntry;
import com.ksinfo.modernize_pro_data.coordinator.quarantine.QuarantineEntryRepository;
import com.ksinfo.modernize_pro_data.coordinator.run.RunHistory;
import com.ksinfo.modernize_pro_data.coordinator.run.RunHistoryRepository;
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
import java.util.List;
import java.util.Map;
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

    /** Run 1 회분의 quarantine group. LogViewerPage 의 quarantine 탭. */
    @GetMapping("/api/v1/runs/{runId}/quarantine")
    public ApiResponse<List<QuarantineGroupView>> listByRun(@PathVariable String runId) {
        List<QuarantineEntry> entries = quarantineRepo.findByRunIdOrderByCreatedAtAsc(runId);
        if (entries.isEmpty()) return ApiResponse.ok(List.of());

        Map<String, String> stageKeyById = loadStageKeys(entries);
        return ApiResponse.ok(entries.stream()
                .map(e -> toGroupView(e, stageKeyById.getOrDefault(e.getStageInstanceId(), "unknown")))
                .toList());
    }

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
            RunHistory latest = runRepo.findFirstByProjectIdOrderByStartedAtDesc(p.getId());
            if (latest == null) continue;

            List<QuarantineEntry> entries = quarantineRepo.findByRunIdOrderByCreatedAtAsc(latest.getId());
            if (entries.isEmpty()) continue;

            Map<String, String> stageKeyById = loadStageKeys(entries);
            for (QuarantineEntry e : entries) {
                String stage = stageKeyById.getOrDefault(e.getStageInstanceId(), "unknown");
                QuarantineGroupView g = toGroupView(e, stage);
                result.add(new SiteQuarantineGroupView(
                        g.id(), g.bindingId(), g.reason(), g.detail(), g.severity(), g.stage(),
                        g.firstSeenAt(), g.table(),
                        g.columns(), g.columnRoles(), g.sampleRows(), g.toBeValues(),
                        g.rowCount(),
                        p.getId(), p.getName()));
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
    private QuarantineGroupView toGroupView(QuarantineEntry e, String stageKeyFallback) {
        Map<String, Object> s = e.getSampleData() == null ? Map.of() : e.getSampleData();
        String stageLabel = s.get("stageLabel") instanceof String sl ? sl : stageKeyFallback;
        return new QuarantineGroupView(
                e.getId(),
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
                e.getRowCount() == null ? 0L : e.getRowCount()
        );
    }

    /* ──────────────────────── DTOs ───────────────────────── */

    public record QuarantineGroupView(
            String id,
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
            long rowCount
    ) {}

    public record SiteQuarantineGroupView(
            String id,
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
            String projectName
    ) {}
}

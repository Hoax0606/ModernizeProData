package com.ksinfo.modernize_pro_data.coordinator.api;

import com.ksinfo.modernize_pro_data.common.dto.ApiResponse;
import com.ksinfo.modernize_pro_data.common.exception.ApiException;
import com.ksinfo.modernize_pro_data.coordinator.mapping.MappingCodeMapRepository;
import com.ksinfo.modernize_pro_data.coordinator.mapping.MappingRuleRepository;
import com.ksinfo.modernize_pro_data.coordinator.mapping.MappingTableBindingRepository;
import com.ksinfo.modernize_pro_data.coordinator.site.AuditLogService;
import com.ksinfo.modernize_pro_data.coordinator.site.Project;
import com.ksinfo.modernize_pro_data.coordinator.site.ProjectRepository;
import com.ksinfo.modernize_pro_data.coordinator.site.Snapshot;
import com.ksinfo.modernize_pro_data.coordinator.site.SnapshotDiffService;
import com.ksinfo.modernize_pro_data.coordinator.site.SnapshotRepository;
import com.ksinfo.modernize_pro_data.coordinator.site.frozen.FrozenBinding;
import com.ksinfo.modernize_pro_data.coordinator.site.frozen.FrozenCodeMap;
import com.ksinfo.modernize_pro_data.coordinator.site.frozen.FrozenRule;
import com.ksinfo.modernize_pro_data.coordinator.site.frozen.SnapshotChanges;
import com.ksinfo.modernize_pro_data.coordinator.site.frozen.SnapshotData;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.HttpStatus;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.security.core.Authentication;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.bind.annotation.*;

import java.time.OffsetDateTime;
import java.util.List;

/**
 * Snapshot CRUD + 상태 전환 API.
 *
 * GET    /api/v1/projects/{projectId}/snapshots — 프로젝트별 목록
 * POST   /api/v1/projects/{projectId}/snapshots — 생성 (draft)
 * POST   /api/v1/snapshots/{id}/request          — draft → pending
 * POST   /api/v1/snapshots/{id}/approve          — pending → approved (master)
 * POST   /api/v1/snapshots/{id}/reject           — pending → rejected (master)
 * DELETE /api/v1/snapshots/{id}                   — 삭제
 * GET    /api/v1/sites/{siteId}/snapshots        — 사이트 전체 스냅샷 (Approvals 용)
 * GET    /api/v1/snapshots/{id}/mapping          — snapshot 의 frozen 매핑 (rules/bindings/codeMaps)
 * POST   /api/v1/snapshots/{id}/baseline         — 이 snapshot 을 project 의 고정핀(baseline) 으로 설정
 * DELETE /api/v1/snapshots/{id}/baseline         — 고정핀 해제
 */
@Slf4j
@RestController
@RequiredArgsConstructor
public class SnapshotController {

    private final SnapshotRepository snapshotRepository;
    private final ProjectRepository projectRepository;
    private final AuditLogService auditLogService;
    private final MappingRuleRepository mappingRuleRepository;
    private final MappingCodeMapRepository mappingCodeMapRepository;
    private final MappingTableBindingRepository mappingTableBindingRepository;
    private final SnapshotDiffService snapshotDiffService;

    /* ── DTOs ──────────────────────────────────── */

    public record CreateSnapshotRequest(
            @NotBlank @Size(max = 128) String name,
            String description,
            String type
    ) {}

    public record RejectRequest(@NotBlank String reason) {}

    /* ── Endpoints ─────────────────────────────── */

    @GetMapping("/api/v1/projects/{projectId}/snapshots")
    public ApiResponse<List<Snapshot>> listByProject(@PathVariable String projectId) {
        return ApiResponse.ok(snapshotRepository.findByProjectId(projectId));
    }

    @GetMapping("/api/v1/sites/{siteId}/snapshots")
    public ApiResponse<List<Snapshot>> listBySite(@PathVariable String siteId) {
        var projectIds = projectRepository.findBySiteId(siteId).stream().map(p -> p.getId()).toList();
        if (projectIds.isEmpty()) return ApiResponse.ok(List.of());
        return ApiResponse.ok(snapshotRepository.findByProjectIdIn(projectIds));
    }

    @PostMapping("/api/v1/projects/{projectId}/snapshots")
    @Transactional
    public ApiResponse<Snapshot> create(
            @PathVariable String projectId,
            @Valid @RequestBody CreateSnapshotRequest req,
            Authentication auth
    ) {
        Project project = projectRepository.findById(projectId)
                .orElseThrow(() -> new ApiException("PROJECT_NOT_FOUND", "프로젝트를 찾을 수 없습니다", HttpStatus.NOT_FOUND));

        String nextVersion = snapshotRepository.findLatestByProjectId(projectId)
                .map(latest -> Snapshot.generateNextVersion(latest.getVersion(), latest.getStatus()))
                .orElse("v1.0");

        // 라이브 mapping working set 을 통째로 동결해 JSONB 1개 컬럼에 저장.
        // entity 직접 직렬화 (lazy/circular) 위험을 피하려고 FrozenXxx record 로 변환.
        List<FrozenRule> rules = mappingRuleRepository.findByProjectId(projectId).stream()
                .map(FrozenRule::fromEntity).toList();
        List<FrozenCodeMap> codeMaps = mappingCodeMapRepository
                .findByProjectIdOrderByDomainAscOrdinalAsc(projectId).stream()
                .map(FrozenCodeMap::fromEntity).toList();
        List<FrozenBinding> bindings = mappingTableBindingRepository
                .findByProjectIdWithSources(projectId).stream()
                .map(FrozenBinding::fromEntity).toList();

        Snapshot s = Snapshot.create(projectId, req.name(), req.description(),
                req.type(), auth.getName(), nextVersion);
        SnapshotData currentData = new SnapshotData(rules, codeMaps, bindings);
        s.setSnapshotData(currentData);
        s.setRuleCount(rules.size());
        s.setTableCount(bindings.size());
        s.setCodeMapCount(codeMaps.size());

        // 비교 기준 결정: baseline 우선 → 없으면 시간순 직전 → 둘 다 없으면 첫 snapshot.
        // s.id 가 unique 하므로 "본인 제외" 는 baseline 의 의미와 무관 (현재 새 s 는 아직 baseline 일 수 없음).
        Snapshot previous = snapshotRepository.findByProjectIdAndBaselineTrue(projectId)
                .or(() -> snapshotRepository.findPreviousByProjectIdExcluding(projectId, s.getId()))
                .orElse(null);
        SnapshotChanges changes = snapshotDiffService.diff(
                previous == null ? null : previous.getSnapshotData(),
                currentData,
                previous == null ? null : previous.getId(),
                previous == null ? null : previous.getVersion()
        );
        s.setChanges(changes);
        s.setPreviousVersionId(previous == null ? null : previous.getId());

        snapshotRepository.save(s);

        log.info("Snapshot created: {} ({}) v{} in project {} — frozen rules={}, tables={}, codeMaps={}; "
                        + "changes vs {} → +{} ~{} -{}",
                s.getName(), s.getType(), s.getVersion(), projectId,
                rules.size(), bindings.size(), codeMaps.size(),
                previous == null ? "(none)" : previous.getVersion(),
                changes.summary().added(), changes.summary().modified(), changes.summary().removed());

        String action = "cutover".equalsIgnoreCase(req.type()) ? "cutover snapshot created" : "snapshot created";
        auditLogService.record(project, auth.getName(), action)
                .snapshot(s.getId(), s.getName())
                .details(req.description())
                .save();
        return ApiResponse.ok(s);
    }

    @PostMapping("/api/v1/snapshots/{id}/request")
    @Transactional
    public ApiResponse<Snapshot> request(@PathVariable String id, Authentication auth) {
        Snapshot s = findOrThrow(id);
        if (!"draft".equals(s.getStatus())) {
            throw new ApiException("SNAPSHOT_INVALID_STATUS", "draft 상태에서만 요청 가능", HttpStatus.BAD_REQUEST);
        }
        s.setStatus("pending");
        snapshotRepository.save(s);
        log.info("Snapshot requested: {} ({}) by {}", s.getName(), s.getId(), auth.getName());

        projectRepository.findById(s.getProjectId()).ifPresent(p ->
                auditLogService.record(p, auth.getName(), "review requested")
                        .snapshot(s.getId(), s.getName())
                        .save());
        return ApiResponse.ok(s);
    }

    @PostMapping("/api/v1/snapshots/{id}/approve")
    @PreAuthorize("hasRole('MASTER')")
    @Transactional
    public ApiResponse<Snapshot> approve(@PathVariable String id, Authentication auth) {
        Snapshot s = findOrThrow(id);
        if (!"pending".equals(s.getStatus())) {
            throw new ApiException("SNAPSHOT_INVALID_STATUS", "pending 상태에서만 승인 가능", HttpStatus.BAD_REQUEST);
        }
        s.setStatus("approved");
        s.setApprovedBy(auth.getName());
        s.setApprovedAt(OffsetDateTime.now());
        snapshotRepository.save(s);
        log.info("Snapshot approved: {} by {}", s.getName(), auth.getName());

        projectRepository.findById(s.getProjectId()).ifPresent(p ->
                auditLogService.record(p, auth.getName(), "approved")
                        .snapshot(s.getId(), s.getName())
                        .save());
        return ApiResponse.ok(s);
    }

    @PostMapping("/api/v1/snapshots/{id}/reject")
    @PreAuthorize("hasRole('MASTER')")
    @Transactional
    public ApiResponse<Snapshot> reject(
            @PathVariable String id,
            @Valid @RequestBody RejectRequest req,
            Authentication auth
    ) {
        Snapshot s = findOrThrow(id);
        if (!"pending".equals(s.getStatus())) {
            throw new ApiException("SNAPSHOT_INVALID_STATUS", "pending 상태에서만 거부 가능", HttpStatus.BAD_REQUEST);
        }
        s.setStatus("rejected");
        s.setRejectedBy(auth.getName());
        s.setRejectedAt(OffsetDateTime.now());
        s.setRejectionReason(req.reason());
        snapshotRepository.save(s);
        log.info("Snapshot rejected: {} by {}", s.getName(), auth.getName());

        projectRepository.findById(s.getProjectId()).ifPresent(p ->
                auditLogService.record(p, auth.getName(), "rejected")
                        .snapshot(s.getId(), s.getName())
                        .details(req.reason())
                        .save());
        return ApiResponse.ok(s);
    }

    /**
     * Snapshot 의 frozen mapping payload 조회.
     * 생성 시점의 mapping_rules / bindings(+sources) / code_maps 가 그대로 JSONB 로 보관돼 있음.
     */
    @GetMapping("/api/v1/snapshots/{id}/mapping")
    public ApiResponse<SnapshotData> getMapping(@PathVariable String id) {
        return ApiResponse.ok(findOrThrow(id).getSnapshotData());
    }

    /**
     * 프로젝트의 "고정핀" 을 이 snapshot 으로 설정. 단일 트랜잭션 안에서 기존 baseline 을 false 로
     * 내리고 본인을 true 로 올린다. partial unique index 가 동시성 race 도 안전망으로 잡아준다.
     */
    @PostMapping("/api/v1/snapshots/{id}/baseline")
    @Transactional
    public ApiResponse<Snapshot> setBaseline(@PathVariable String id, Authentication auth) {
        Snapshot s = findOrThrow(id);
        if (s.isBaseline()) {
            return ApiResponse.ok(s);
        }
        snapshotRepository.findByProjectIdAndBaselineTrue(s.getProjectId()).ifPresent(prev -> {
            prev.setBaseline(false);
            snapshotRepository.save(prev);
        });
        snapshotRepository.flush(); // partial unique index 충돌 방지: prev false 가 새 true 보다 먼저 DB 에 도달
        s.setBaseline(true);
        snapshotRepository.save(s);
        log.info("Snapshot baseline set: {} ({}) by {}", s.getName(), s.getId(), auth.getName());

        projectRepository.findById(s.getProjectId()).ifPresent(p ->
                auditLogService.record(p, auth.getName(), "baseline set")
                        .snapshot(s.getId(), s.getName())
                        .save());
        return ApiResponse.ok(s);
    }

    /** baseline 해제 — 현재 baseline 이 아니더라도 idempotent. */
    @DeleteMapping("/api/v1/snapshots/{id}/baseline")
    @Transactional
    public ApiResponse<Snapshot> clearBaseline(@PathVariable String id, Authentication auth) {
        Snapshot s = findOrThrow(id);
        if (!s.isBaseline()) {
            return ApiResponse.ok(s);
        }
        s.setBaseline(false);
        snapshotRepository.save(s);
        log.info("Snapshot baseline cleared: {} ({}) by {}", s.getName(), s.getId(), auth.getName());

        projectRepository.findById(s.getProjectId()).ifPresent(p ->
                auditLogService.record(p, auth.getName(), "baseline cleared")
                        .snapshot(s.getId(), s.getName())
                        .save());
        return ApiResponse.ok(s);
    }

    @DeleteMapping("/api/v1/snapshots/{id}")
    @Transactional
    public ApiResponse<Void> delete(@PathVariable String id, Authentication auth) {
        Snapshot s = findOrThrow(id);
        String snapshotName = s.getName();
        String projectId = s.getProjectId();
        snapshotRepository.delete(s);

        projectRepository.findById(projectId).ifPresent(p ->
                auditLogService.record(p, auth.getName(), "snapshot deleted")
                        .snapshot(id, snapshotName)
                        .save());
        return ApiResponse.ok(null);
    }

    private Snapshot findOrThrow(String id) {
        return snapshotRepository.findById(id)
                .orElseThrow(() -> new ApiException("SNAPSHOT_NOT_FOUND", "스냅샷을 찾을 수 없습니다", HttpStatus.NOT_FOUND));
    }
}

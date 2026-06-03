package com.ksinfo.modernize_pro_data.coordinator.api;

import com.ksinfo.modernize_pro_data.common.dto.ApiResponse;
import com.ksinfo.modernize_pro_data.common.exception.ApiException;
import com.ksinfo.modernize_pro_data.coordinator.mapping.MappingAsisSkip;
import com.ksinfo.modernize_pro_data.coordinator.mapping.MappingAsisSkipRepository;
import com.ksinfo.modernize_pro_data.coordinator.mapping.MappingCodeMap;
import com.ksinfo.modernize_pro_data.coordinator.mapping.MappingCodeMapRepository;
import com.ksinfo.modernize_pro_data.coordinator.mapping.MappingRule;
import com.ksinfo.modernize_pro_data.coordinator.mapping.MappingRuleRepository;
import com.ksinfo.modernize_pro_data.coordinator.mapping.MappingTableBinding;
import com.ksinfo.modernize_pro_data.coordinator.mapping.MappingTableBindingRepository;
import com.ksinfo.modernize_pro_data.coordinator.mapping.MappingTableBindingSource;
import com.ksinfo.modernize_pro_data.coordinator.site.frozen.FrozenAsisSkip;
import com.ksinfo.modernize_pro_data.coordinator.site.frozen.FrozenBindingSource;
import com.ksinfo.modernize_pro_data.coordinator.site.AuditLogService;
import com.ksinfo.modernize_pro_data.coordinator.site.Project;
import com.ksinfo.modernize_pro_data.coordinator.site.ProjectRepository;
import com.ksinfo.modernize_pro_data.coordinator.site.Snapshot;
import com.ksinfo.modernize_pro_data.coordinator.site.SnapshotDiffService;
import com.ksinfo.modernize_pro_data.coordinator.site.SnapshotRepository;
import com.ksinfo.modernize_pro_data.coordinator.run.RunHistoryRepository;
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
import java.util.UUID;

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
    private final MappingAsisSkipRepository mappingAsisSkipRepository;
    private final SnapshotDiffService snapshotDiffService;
    private final RunHistoryRepository runHistoryRepository;
    private final com.ksinfo.modernize_pro_data.coordinator.site.SnapshotMappingRestoreService snapshotMappingRestoreService;
    /** self proxy — setBaseline retry loop 가 transaction 경계를 넘어 재호출하기 위함.
     *  ObjectProvider 로 지연 주입 (생성자 순환 회피). */
    private final org.springframework.beans.factory.ObjectProvider<SnapshotController> selfProvider;

    /* ── DTOs ──────────────────────────────────── */

    public record CreateSnapshotRequest(
            @NotBlank @Size(max = 128) String name,
            String description,
            String type
    ) {}

    public record RejectRequest(@NotBlank String reason) {}

    /* ── Endpoints ─────────────────────────────── */

    @GetMapping("/api/v1/projects/{projectId}/snapshots")
    public ApiResponse<List<com.ksinfo.modernize_pro_data.coordinator.site.SnapshotSummaryView>> listByProject(@PathVariable String projectId) {
        // snapshot_data 제외 projection — list 응답에 frozen mapping payload 불필요.
        return ApiResponse.ok(snapshotRepository.findSummaryByProjectId(projectId));
    }

    @GetMapping("/api/v1/sites/{siteId}/snapshots")
    public ApiResponse<List<com.ksinfo.modernize_pro_data.coordinator.site.SnapshotSummaryView>> listBySite(@PathVariable String siteId) {
        var projectIds = projectRepository.findBySiteId(siteId).stream().map(p -> p.getId()).toList();
        if (projectIds.isEmpty()) return ApiResponse.ok(List.of());
        return ApiResponse.ok(snapshotRepository.findSummaryByProjectIdIn(projectIds));
    }

    /** 현재 라이브 mapping working set 을 SnapshotData (rules + codeMaps + bindings) 로 freeze.
     *  create() 와 has-changes preview endpoint 둘 다 사용 — 일관성 보장.
     *
     *  라이브 mapping working set 을 통째로 동결해 JSONB 1개 컬럼에 저장.
     *  자식 link binding 은 sharedFromProjectId 마커만 freeze — master 의 룰은 복사 안 함.
     *  실행 시점에 read-time inherit 로 처리. snapshot restore 시 link 마커가 그대로 복원되어
     *  그 시점의 link 사실만 보존 (master 가 나중에 룰 바꾸면 자식 snapshot 의 read 결과도 변화).
     *  entity 직접 직렬화 (lazy/circular) 위험을 피하려고 FrozenXxx record 로 변환. */
    private SnapshotData buildCurrentSnapshotData(String projectId) {
        // 자식 link binding 은 sharedFromProjectId 마커만 freeze — master 의 룰 복사 X.
        // 실행 시점에 read-time inherit 로 처리. restore 시 link 마커 그대로 복원.
        List<MappingTableBinding> ownBindings = mappingTableBindingRepository
                .findByProjectIdWithSources(projectId);
        List<MappingRule> ownRules = mappingRuleRepository.findByProjectId(projectId);
        List<FrozenCodeMap> codeMaps = mappingCodeMapRepository
                .findByProjectIdOrderByDomainAscOrdinalAsc(projectId).stream()
                .map(FrozenCodeMap::fromEntity).toList();

        List<FrozenBinding> bindings = ownBindings.stream()
                .map(FrozenBinding::fromEntity)
                .toList();
        List<FrozenRule> rules = ownRules.stream()
                .map(FrozenRule::fromEntity)
                .toList();
        List<FrozenAsisSkip> asisSkips = mappingAsisSkipRepository.findByProjectId(projectId).stream()
                .map(FrozenAsisSkip::fromEntity)
                .toList();
        return new SnapshotData(rules, codeMaps, bindings, asisSkips);
    }

    /** + New snapshot / + Cutover snapshot 버튼 활성화 판단용.
     *  - hasChanges: 직전 snapshot 대비 mapping 변경이 있는지. mapping snapshot 활성 기준.
     *  - hasRun:     이 project 에 run 이력이 한 번이라도 있는지. cutover snapshot 활성 기준
     *                (cutover 는 mapping 변경 없이도 한 run 결과를 새 cutover 로 박을 수 있음).
     *  - added/modified/removed: 사용자 안내 카운트. */
    public record HasChangesView(boolean hasChanges, boolean hasRun,
                                 int added, int modified, int removed) {}

    @GetMapping("/api/v1/projects/{projectId}/snapshots/has-changes")
    public ApiResponse<HasChangesView> hasChangesSinceLatest(@PathVariable String projectId) {
        projectRepository.findById(projectId)
                .orElseThrow(() -> new ApiException("PROJECT_NOT_FOUND",
                        "프로젝트를 찾을 수 없습니다", HttpStatus.NOT_FOUND));
        boolean hasRun = runHistoryRepository.countByProjectId(projectId) > 0;
        Snapshot previous = snapshotRepository.findByProjectIdAndBaselineTrue(projectId)
                .or(() -> snapshotRepository.findLatestByProjectId(projectId))
                .orElse(null);
        if (previous == null) {
            // 첫 snapshot — 항상 만들 수 있다.
            return ApiResponse.ok(new HasChangesView(true, hasRun, 0, 0, 0));
        }
        SnapshotData currentData = buildCurrentSnapshotData(projectId);
        SnapshotChanges ch = snapshotDiffService.diff(
                previous.getSnapshotData(), currentData,
                previous.getId(), previous.getVersion());
        int a = ch.summary().added(), m = ch.summary().modified(), r = ch.summary().removed();
        return ApiResponse.ok(new HasChangesView(a + m + r > 0, hasRun, a, m, r));
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

        SnapshotData currentData = buildCurrentSnapshotData(projectId);
        List<FrozenRule> rules = currentData.rules();
        List<FrozenCodeMap> codeMaps = currentData.codeMaps();
        List<FrozenBinding> bindings = currentData.bindings();

        Snapshot s = Snapshot.create(projectId, req.name(), req.description(),
                req.type(), auth.getName(), nextVersion);
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
        // 직전 snapshot 과 비교해 변경이 하나도 없으면 새 mapping snapshot 생성을 막는다.
        // (첫 snapshot 은 previous == null 이라 이 가드에 안 걸린다.)
        // Cutover snapshot 은 mapping 변경 무관 — 한 run 결과를 박는 의미라 통과.
        if (!"cutover".equalsIgnoreCase(req.type())
                && previous != null
                && changes.summary().added() == 0
                && changes.summary().modified() == 0
                && changes.summary().removed() == 0) {
            throw new ApiException("SNAPSHOT_NO_CHANGES",
                    "변경된 매핑이 없어 새 snapshot 을 만들지 않았어요. " +
                    "직전 snapshot (" + previous.getVersion() + ") 과 동일해요.",
                    HttpStatus.CONFLICT);
        }
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
     * 프로젝트의 "고정핀" 을 이 snapshot 으로 설정 + **live mapping_* 를 snapshot 시점으로 restore**.
     *
     * Restore 모델: 핀을 누른다는 것은 "이 snapshot 으로 돌아가서 작업한다" 라는 의미.
     * mapping_rules / mapping_code_maps / mapping_table_bindings 가 모두 snapshot.snapshotData
     * 시점 데이터로 wipe + replace 된다. 사용자가 단순 보기만 하려고 핀을 눌렀어도 live 가
     * 교체되는 destructive 액션이다 (모델 결정 — UX option A).
     *
     * 단일 트랜잭션 안에서 기존 baseline 을 false 로 내리고 본인을 true 로 올린다 +
     * mapping_* 데이터를 restore. partial unique index 가 동시성 race 도 안전망으로 잡아준다.
     */
    /**
     * Baseline 설정 — multi-user 동시 setBaseline 시 restoreMapping 의 cascade
     * DELETE 가 같은 row 를 동시 수정하면 ObjectOptimisticLockingFailureException
     * 발생. 최대 3회 재시도 (self proxy 통해 매 시도 새 transaction). FE 의
     * inflight guard 가 1차 방어, 이 retry 가 다른 PC 동시 요청의 2차 방어.
     */
    @PostMapping("/api/v1/snapshots/{id}/baseline")
    public ApiResponse<Snapshot> setBaseline(@PathVariable String id, Authentication auth) {
        String actor = auth.getName();
        int maxAttempts = 3;
        for (int attempt = 1; ; attempt++) {
            try {
                return selfProvider.getObject().setBaselineTx(id, actor);
            } catch (org.springframework.dao.OptimisticLockingFailureException e) {
                if (attempt >= maxAttempts) {
                    log.warn("setBaseline failed after {} attempts (optimistic lock): {}", attempt, id);
                    throw e;
                }
                log.info("setBaseline retry {}/{} (optimistic lock): {}", attempt, maxAttempts, id);
            }
        }
    }

    /** setBaseline 의 transaction 본체 — retry loop 가 매 시도 새 transaction 으로 호출.
     *  public 필수 (self proxy 가 AOP transaction advice 적용하려면). */
    @Transactional
    public ApiResponse<Snapshot> setBaselineTx(String id, String actor) {
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

        // mapping_* 를 snapshot 시점으로 restore.
        restoreMappingFromSnapshot(s, actor);

        log.info("Snapshot baseline set + mapping restored: {} ({}) by {}", s.getName(), s.getId(), actor);

        projectRepository.findById(s.getProjectId()).ifPresent(p ->
                auditLogService.record(p, actor, "baseline set (mapping restored)")
                        .snapshot(s.getId(), s.getName())
                        .save());
        return ApiResponse.ok(s);
    }

    /**
     * snapshot.snapshotData 의 frozen rules / codeMaps / bindings / asisSkips 를
     * 활성 mapping_* 테이블로 복원한다.
     *
     * 절차:
     *  1) 해당 project 의 기존 mapping_* row 전부 삭제 (bindings 는 sources cascade
     *     위해 entity-level deleteAll). flush 로 DB 반영.
     *  2) {@link SnapshotMappingRestoreService} 가 PG-side {@code jsonb_to_recordset}
     *     으로 snapshot_data JSONB → mapping_* INSERT 를 한 SQL 안에서 수행 (Java
     *     unpack / JpaRepository.save loop 없음). 큰 mapping 에서 baseline pin
     *     30s → 2~3s 단축이 핵심 이득.
     */
    private void restoreMappingFromSnapshot(Snapshot snapshot, String userId) {
        SnapshotData data = snapshot.getSnapshotData();
        if (data == null) {
            log.warn("Snapshot {} has no snapshotData — restore skipped", snapshot.getId());
            return;
        }
        String projectId = snapshot.getProjectId();

        // 1) wipe — bindings 는 sources cascade 가 필요해 entity-level deleteAll.
        mappingTableBindingRepository.deleteAll(
                mappingTableBindingRepository.findByProjectIdWithSources(projectId));
        mappingRuleRepository.deleteAllByProjectId(projectId);
        mappingCodeMapRepository.deleteAllByProjectId(projectId);
        mappingAsisSkipRepository.deleteAllByProjectId(projectId);
        // DELETE 반영 — 같은 트랜잭션 안 새 insert 가 1차 캐시 충돌하지 않도록.
        mappingTableBindingRepository.flush();
        mappingRuleRepository.flush();
        mappingCodeMapRepository.flush();

        // 2) PG-side INSERT (jsonb_to_recordset). entity loop 비교 round-trip 동치.
        snapshotMappingRestoreService.restore(snapshot.getId(), projectId, userId);
    }

    // 옛 entity-loop 패턴 (rules/codeMaps/bindings+sources/asisSkips 각각 for loop)
    // 은 SnapshotMappingRestoreService 가 단일 PG SQL 로 대체. 큰 dataset 의 30s+
    // 비용 (Jackson deserialize + entity save loop) 제거.
    /* 이전 코드 (참고용 주석, 동치성 검증 후 제거 예정 — 2026-06-01) */
    @SuppressWarnings("unused")
    private void restoreMappingFromSnapshotLegacy(Snapshot snapshot, String userId) {
        SnapshotData data = snapshot.getSnapshotData();
        if (data == null) return;
        String projectId = snapshot.getProjectId();
        OffsetDateTime now = OffsetDateTime.now();

        // 3) rules
        if (data.rules() != null) {
            for (FrozenRule r : data.rules()) {
                MappingRule e = new MappingRule();
                e.setId(UUID.randomUUID().toString());
                e.setProjectId(projectId);
                // 옛 snapshot (importId 필드 추가 전) 은 r.importId() == null — 그땐 null 그대로.
                // 새 snapshot 부턴 원본 import trace 가 보존됨. mapping_imports FK 는
                // ON DELETE SET NULL 이라 import 가 지워져도 안전.
                e.setImportId(r.importId());
                e.setTobeSchema(r.tobeSchema());
                e.setTobeTable(r.tobeTable());
                e.setTobeColumn(r.tobeColumn());
                e.setAsisSchema(r.asisSchema());
                e.setAsisTable(r.asisTable());
                e.setAsisColumn(r.asisColumn());
                e.setAsisType(r.asisType());
                e.setCodeDomain(r.codeDomain());
                e.setStrategy(r.strategy());
                e.setTransformRule(r.transformRule());
                e.setTransformSql(r.transformSql());
                e.setDefaultValue(r.defaultValue());
                e.setNotNullOverride(r.notNullOverride());
                e.setRuleOrigin(r.ruleOrigin());
                e.setNotes(r.notes());
                e.setCreatedBy(r.createdBy() != null ? r.createdBy() : userId);
                e.setCreatedAt(r.createdAt() != null ? r.createdAt() : now);
                e.setUpdatedBy(userId);
                e.setUpdatedAt(now);
                mappingRuleRepository.save(e);
            }
        }

        // codeMaps
        if (data.codeMaps() != null) {
            for (FrozenCodeMap m : data.codeMaps()) {
                MappingCodeMap e = new MappingCodeMap();
                e.setId(UUID.randomUUID().toString());
                e.setProjectId(projectId);
                e.setImportId(null);
                e.setDomain(m.domain());
                e.setSourceValue(m.sourceValue());
                e.setTargetValue(m.targetValue());
                e.setDescription(m.description());
                e.setOrdinal(m.ordinal());
                mappingCodeMapRepository.save(e);
            }
        }

        // bindings (+ sources cascade)
        if (data.bindings() != null) {
            for (FrozenBinding b : data.bindings()) {
                MappingTableBinding e = new MappingTableBinding();
                e.setId(UUID.randomUUID().toString());
                e.setProjectId(projectId);
                e.setImportId(null);
                e.setTobeSchema(b.tobeSchema());
                e.setTobeTable(b.tobeTable());
                e.setCompositionKind(b.compositionKind());
                e.setWhereFilter(b.whereFilter());
                e.setBindingOrigin(b.bindingOrigin());
                e.setSharedFromProjectId(b.sharedFromProjectId());
                e.setGroupByExpr(b.groupByExpr());
                e.setExpandExpr(b.expandExpr());
                e.setCreatedBy(b.createdBy() != null ? b.createdBy() : userId);
                e.setCreatedAt(b.createdAt() != null ? b.createdAt() : now);
                e.setUpdatedBy(userId);
                e.setUpdatedAt(now);
                if (b.sources() != null) {
                    for (FrozenBindingSource s : b.sources()) {
                        MappingTableBindingSource src = new MappingTableBindingSource();
                        src.setId(UUID.randomUUID().toString());
                        src.setOrdinal(s.ordinal());
                        src.setAsisSchema(s.asisSchema());
                        src.setAsisTable(s.asisTable());
                        src.setAlias(s.alias());
                        src.setRole(s.role());
                        src.setJoinType(s.joinType());
                        src.setJoinOn(s.joinOn());
                        e.addSource(src);
                    }
                }
                mappingTableBindingRepository.save(e);
            }
        }

        // asis skips
        if (data.asisSkips() != null) {
            for (FrozenAsisSkip s : data.asisSkips()) {
                MappingAsisSkip e = new MappingAsisSkip();
                e.setId(UUID.randomUUID().toString());
                e.setProjectId(projectId);
                e.setAsisSchema(s.asisSchema() == null ? "" : s.asisSchema());
                e.setAsisTable(s.asisTable());
                e.setAsisColumn(s.asisColumn());
                e.setCreatedBy(userId);
                e.setCreatedAt(now);
                mappingAsisSkipRepository.save(e);
            }
        }
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

    /** "{schema}|{table}" key for linkedKeys set. nz() 로 schema null 도 안전하게. */
    private static String keyOf(String schema, String table) {
        return nz(schema) + "|" + table;
    }

    private static String nz(String s) {
        return s == null ? "" : s;
    }

    private Snapshot findOrThrow(String id) {
        return snapshotRepository.findById(id)
                .orElseThrow(() -> new ApiException("SNAPSHOT_NOT_FOUND", "스냅샷을 찾을 수 없습니다", HttpStatus.NOT_FOUND));
    }
}

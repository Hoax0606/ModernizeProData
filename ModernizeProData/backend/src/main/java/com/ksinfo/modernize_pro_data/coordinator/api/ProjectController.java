package com.ksinfo.modernize_pro_data.coordinator.api;

import com.ksinfo.modernize_pro_data.common.dto.ApiResponse;
import com.ksinfo.modernize_pro_data.common.exception.ApiException;
import com.ksinfo.modernize_pro_data.coordinator.site.AuditLogService;
import com.ksinfo.modernize_pro_data.coordinator.site.Project;
import com.ksinfo.modernize_pro_data.coordinator.site.ProjectRepository;
import com.ksinfo.modernize_pro_data.coordinator.site.SiteRepository;
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

import java.util.List;
import java.util.Map;

/**
 * Project CRUD API.
 *
 * GET    /api/v1/sites/{siteId}/projects — 해당 사이트 프로젝트 목록
 * POST   /api/v1/sites/{siteId}/projects — 생성
 * GET    /api/v1/projects/{id}           — 단일 조회
 * PATCH  /api/v1/projects/{id}           — 수정
 * DELETE /api/v1/projects/{id}           — 삭제
 */
@Slf4j
@RestController
@RequiredArgsConstructor
public class ProjectController {

    private final ProjectRepository projectRepository;
    private final SiteRepository siteRepository;
    private final AuditLogService auditLogService;

    /* ── DTOs ──────────────────────────────────────── */

    public record CreateProjectRequest(
            @NotBlank @Size(max = 128) String name,
            String phase,
            int tableCount,
            List<Map<String, Object>> ddlFiles,
            String assignee
    ) {}

    public record UpdateProjectRequest(
            @Size(max = 128) String name,
            String phase,
            Integer tableCount,
            List<Map<String, Object>> ddlFiles,
            String owner,
            String assignee,
            String executionAssignee,
            String runStatus,
            Map<String, Object> tobeDbByEnv,
            Map<String, Boolean> tobeDbLocks
    ) {}

    /* ── Endpoints ─────────────────────────────────── */

    @GetMapping("/api/v1/sites/{siteId}/projects")
    public ApiResponse<List<Project>> listBySite(@PathVariable String siteId) {
        if (!siteRepository.existsById(siteId)) {
            throw new ApiException("SITE_NOT_FOUND", "사이트를 찾을 수 없습니다", HttpStatus.NOT_FOUND);
        }
        return ApiResponse.ok(projectRepository.findBySiteId(siteId));
    }

    @PostMapping("/api/v1/sites/{siteId}/projects")
    @PreAuthorize("hasAnyRole('MASTER','ADMIN')")
    @Transactional
    public ApiResponse<Project> create(
            @PathVariable String siteId,
            @Valid @RequestBody CreateProjectRequest req,
            Authentication auth
    ) {
        if (!siteRepository.existsById(siteId)) {
            throw new ApiException("SITE_NOT_FOUND", "사이트를 찾을 수 없습니다", HttpStatus.NOT_FOUND);
        }
        if (projectRepository.existsBySiteIdAndName(siteId, req.name())) {
            throw new ApiException("PROJECT_NAME_DUPLICATE",
                    "같은 이름의 프로젝트가 이미 존재합니다", HttpStatus.CONFLICT);
        }
        Project p = Project.create(siteId, req.name(), auth.getName());
        if (req.phase() != null)    p.setPhase(req.phase());
        p.setTableCount(req.tableCount());
        if (req.ddlFiles() != null) p.setDdlFiles(req.ddlFiles());
        if (req.assignee() != null) p.setAssignee(req.assignee());
        projectRepository.save(p);
        log.info("Project created: {} in site {}", p.getName(), siteId);
        auditLogService.record(p, auth.getName(), "project created")
                .target(p.getName()).save();
        return ApiResponse.ok(p);
    }

    @GetMapping("/api/v1/projects/{id}")
    public ApiResponse<Project> get(@PathVariable String id) {
        Project p = projectRepository.findById(id)
                .orElseThrow(() -> new ApiException("PROJECT_NOT_FOUND", "프로젝트를 찾을 수 없습니다", HttpStatus.NOT_FOUND));
        return ApiResponse.ok(p);
    }

    @PatchMapping("/api/v1/projects/{id}")
    @PreAuthorize("hasAnyRole('MASTER','ADMIN')")
    @Transactional
    public ApiResponse<Project> update(@PathVariable String id, @Valid @RequestBody UpdateProjectRequest req, Authentication auth) {
        Project p = projectRepository.findById(id)
                .orElseThrow(() -> new ApiException("PROJECT_NOT_FOUND", "프로젝트를 찾을 수 없습니다", HttpStatus.NOT_FOUND));

        if (req.name() != null && !req.name().equals(p.getName())
                && projectRepository.existsBySiteIdAndNameAndIdNot(p.getSiteId(), req.name(), id)) {
            throw new ApiException("PROJECT_NAME_DUPLICATE",
                    "같은 이름의 프로젝트가 이미 존재합니다", HttpStatus.CONFLICT);
        }
        String prevPhase = p.getPhase();
        String prevAssignee = p.getAssignee();
        String prevExecutionAssignee = p.getExecutionAssignee();

        if (req.name() != null)       p.setName(req.name());
        if (req.phase() != null)      p.setPhase(req.phase());
        if (req.tableCount() != null) p.setTableCount(req.tableCount());
        if (req.ddlFiles() != null)   p.setDdlFiles(req.ddlFiles());
        if (req.owner() != null)      p.setOwner(req.owner());
        // assignee: empty string 은 명시적 clear (null 로 set), 누락(null) 은 변경 없음
        if (req.assignee() != null) {
            String newAssignee = req.assignee().isEmpty() ? null : req.assignee();
            log.info("Project {} assignee: {} -> {}", id, p.getAssignee(), newAssignee);
            p.setAssignee(newAssignee);
        }
        if (req.executionAssignee() != null) {
            String newExec = req.executionAssignee().isEmpty() ? null : req.executionAssignee();
            log.info("Project {} executionAssignee: {} -> {}", id, p.getExecutionAssignee(), newExec);
            p.setExecutionAssignee(newExec);
        }
        if (req.runStatus() != null)  p.setRunStatus(req.runStatus());
        // Per-project TO-BE DB (Site.tobeDbScope=="project" 일 때만 의미가 있지만, 모드 무관하게
        //   PATCH 가 들어오면 그대로 저장 — scope 전환 후의 dormant 데이터 보존을 위해서도 동일).
        if (req.tobeDbByEnv() != null) p.setTobeDbByEnv(req.tobeDbByEnv());
        if (req.tobeDbLocks() != null) p.setTobeDbLocks(req.tobeDbLocks());

        // audit log — 의미 있는 변경만 기록. 3개 nested save 대신 batch saveAll
        // (transaction time 단축 → PESSIMISTIC lock 잡고 있는 시간 짧음 → rename concurrent 개선).
        String actor = auth != null ? auth.getName() : "system";
        java.util.List<com.ksinfo.modernize_pro_data.coordinator.site.AuditLog> pending = new java.util.ArrayList<>(3);
        if (req.phase() != null && !java.util.Objects.equals(prevPhase, p.getPhase())) {
            var a = com.ksinfo.modernize_pro_data.coordinator.site.AuditLog
                    .create(p.getSiteId(), p.getId(), actor, "phase changed");
            a.setDetails(prevPhase + " → " + p.getPhase());
            pending.add(a);
        }
        if (req.assignee() != null && !java.util.Objects.equals(prevAssignee, p.getAssignee())) {
            var a = com.ksinfo.modernize_pro_data.coordinator.site.AuditLog
                    .create(p.getSiteId(), p.getId(), actor, "assignee changed");
            a.setDetails((prevAssignee == null ? "(none)" : prevAssignee) + " → "
                    + (p.getAssignee() == null ? "(none)" : p.getAssignee()));
            pending.add(a);
        }
        if (req.executionAssignee() != null && !java.util.Objects.equals(prevExecutionAssignee, p.getExecutionAssignee())) {
            var a = com.ksinfo.modernize_pro_data.coordinator.site.AuditLog
                    .create(p.getSiteId(), p.getId(), actor, "execution assignee changed");
            a.setDetails((prevExecutionAssignee == null ? "(none)" : prevExecutionAssignee) + " → "
                    + (p.getExecutionAssignee() == null ? "(none)" : p.getExecutionAssignee()));
            pending.add(a);
        }
        if (!pending.isEmpty()) auditLogService.saveAll(pending);

        projectRepository.save(p);
        log.info("Project updated: {} ({}) — assignee={} executionAssignee={}",
                p.getName(), p.getId(), p.getAssignee(), p.getExecutionAssignee());
        return ApiResponse.ok(p);
    }

    @DeleteMapping("/api/v1/projects/{id}")
    @PreAuthorize("hasAnyRole('MASTER','ADMIN')")
    @Transactional
    public ApiResponse<Void> delete(@PathVariable String id) {
        Project p = projectRepository.findById(id)
                .orElseThrow(() -> new ApiException("PROJECT_NOT_FOUND", "프로젝트를 찾을 수 없습니다", HttpStatus.NOT_FOUND));
        projectRepository.delete(p);
        log.info("Project deleted: {} ({})", p.getName(), p.getId());
        return ApiResponse.ok(null);
    }
}

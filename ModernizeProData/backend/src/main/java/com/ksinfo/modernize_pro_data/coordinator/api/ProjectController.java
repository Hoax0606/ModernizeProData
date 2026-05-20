package com.ksinfo.modernize_pro_data.coordinator.api;

import com.ksinfo.modernize_pro_data.common.dto.ApiResponse;
import com.ksinfo.modernize_pro_data.common.exception.ApiException;
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
            Map<String, Object> cutover,
            String runStatus
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
    public ApiResponse<Project> update(@PathVariable String id, @Valid @RequestBody UpdateProjectRequest req) {
        Project p = projectRepository.findById(id)
                .orElseThrow(() -> new ApiException("PROJECT_NOT_FOUND", "프로젝트를 찾을 수 없습니다", HttpStatus.NOT_FOUND));

        if (req.name() != null && !req.name().equals(p.getName())
                && projectRepository.existsBySiteIdAndNameAndIdNot(p.getSiteId(), req.name(), id)) {
            throw new ApiException("PROJECT_NAME_DUPLICATE",
                    "같은 이름의 프로젝트가 이미 존재합니다", HttpStatus.CONFLICT);
        }
        if (req.name() != null)       p.setName(req.name());
        if (req.phase() != null)      p.setPhase(req.phase());
        if (req.tableCount() != null) p.setTableCount(req.tableCount());
        if (req.ddlFiles() != null)   p.setDdlFiles(req.ddlFiles());
        if (req.owner() != null)      p.setOwner(req.owner());
        if (req.assignee() != null)   p.setAssignee(req.assignee());
        if (req.cutover() != null)    p.setCutover(req.cutover());
        if (req.runStatus() != null)  p.setRunStatus(req.runStatus());

        projectRepository.save(p);
        log.info("Project updated: {} ({})", p.getName(), p.getId());
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

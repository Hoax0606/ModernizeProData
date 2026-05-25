package com.ksinfo.modernize_pro_data.coordinator.api;

import com.ksinfo.modernize_pro_data.common.dto.ApiResponse;
import com.ksinfo.modernize_pro_data.common.exception.ApiException;
import com.ksinfo.modernize_pro_data.coordinator.site.Site;
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
 * Site CRUD API.
 *
 * GET    /api/v1/sites           — 전체 목록 (인증된 사용자)
 * POST   /api/v1/sites           — 생성 (master, admin)
 * GET    /api/v1/sites/{id}      — 단일 조회
 * PATCH  /api/v1/sites/{id}      — 수정 (master, admin)
 * DELETE /api/v1/sites/{id}      — 삭제 (master only)
 */
@Slf4j
@RestController
@RequestMapping("/api/v1/sites")
@RequiredArgsConstructor
public class SiteController {

    private final SiteRepository siteRepository;

    /* ── DTOs ──────────────────────────────────────── */

    public record CreateSiteRequest(
            @NotBlank @Size(max = 128) String name,
            @NotBlank String asisEnv,
            @NotBlank String tobeEnv,
            @NotBlank String asisEncoding,
            @NotBlank String tobeEncoding,
            String csvPath,
            String asisDbType,
            String asisDbVersion,
            String notes,
            String environment,
            Map<String, Object> tobeDbByEnv,
            Map<String, Boolean> tobeDbLocks
    ) {}

    public record UpdateSiteRequest(
            @Size(max = 128) String name,
            String asisEnv,
            String tobeEnv,
            String asisEncoding,
            String tobeEncoding,
            String csvPath,
            String asisDbType,
            String asisDbVersion,
            String notes,
            String environment,
            Map<String, Object> tobeDbByEnv,
            Map<String, Boolean> tobeDbLocks
    ) {}

    /* ── Endpoints ─────────────────────────────────── */

    @GetMapping
    public ApiResponse<List<Site>> list() {
        return ApiResponse.ok(siteRepository.findAll());
    }

    @GetMapping("/{id}")
    public ApiResponse<Site> get(@PathVariable String id) {
        Site site = siteRepository.findById(id)
                .orElseThrow(() -> new ApiException("SITE_NOT_FOUND", "사이트를 찾을 수 없습니다", HttpStatus.NOT_FOUND));
        return ApiResponse.ok(site);
    }

    @PostMapping
    @PreAuthorize("hasAnyRole('MASTER','ADMIN')")
    @Transactional
    public ApiResponse<Site> create(@Valid @RequestBody CreateSiteRequest req, Authentication auth) {
        if (siteRepository.existsByName(req.name())) {
            throw new ApiException("SITE_NAME_DUPLICATE",
                    "같은 이름의 사이트가 이미 존재합니다", HttpStatus.CONFLICT);
        }
        Site site = Site.create(
                req.name(), req.asisEnv(), req.tobeEnv(),
                req.asisEncoding(), req.tobeEncoding(),
                req.csvPath(), req.notes(), req.environment(),
                req.tobeDbByEnv(), req.tobeDbLocks(),
                auth.getName()
        );
        if (req.asisDbType() != null)    site.setAsisDbType(req.asisDbType());
        if (req.asisDbVersion() != null) site.setAsisDbVersion(req.asisDbVersion());
        siteRepository.save(site);
        log.info("Site created: {} ({})", site.getName(), site.getId());
        return ApiResponse.ok(site);
    }

    @PatchMapping("/{id}")
    @PreAuthorize("hasAnyRole('MASTER','ADMIN')")
    @Transactional
    public ApiResponse<Site> update(@PathVariable String id, @Valid @RequestBody UpdateSiteRequest req) {
        Site site = siteRepository.findById(id)
                .orElseThrow(() -> new ApiException("SITE_NOT_FOUND", "사이트를 찾을 수 없습니다", HttpStatus.NOT_FOUND));

        if (req.name() != null && !req.name().equals(site.getName())
                && siteRepository.existsByNameAndIdNot(req.name(), id)) {
            throw new ApiException("SITE_NAME_DUPLICATE",
                    "같은 이름의 사이트가 이미 존재합니다", HttpStatus.CONFLICT);
        }
        if (req.name() != null)         site.setName(req.name());
        if (req.asisEnv() != null)      site.setAsisEnv(req.asisEnv());
        if (req.tobeEnv() != null)      site.setTobeEnv(req.tobeEnv());
        if (req.asisEncoding() != null) site.setAsisEncoding(req.asisEncoding());
        if (req.tobeEncoding() != null) site.setTobeEncoding(req.tobeEncoding());
        if (req.csvPath() != null)      site.setCsvPath(req.csvPath());
        if (req.asisDbType() != null)    site.setAsisDbType(req.asisDbType().isEmpty() ? null : req.asisDbType());
        if (req.asisDbVersion() != null) site.setAsisDbVersion(req.asisDbVersion().isEmpty() ? null : req.asisDbVersion());
        if (req.notes() != null)        site.setNotes(req.notes());
        if (req.environment() != null)  site.setEnvironment(req.environment());
        if (req.tobeDbByEnv() != null)  site.setTobeDbByEnv(req.tobeDbByEnv());
        if (req.tobeDbLocks() != null)  site.setTobeDbLocks(req.tobeDbLocks());

        siteRepository.save(site);
        log.info("Site updated: {} ({})", site.getName(), site.getId());
        return ApiResponse.ok(site);
    }

    @DeleteMapping("/{id}")
    @PreAuthorize("hasRole('MASTER')")
    @Transactional
    public ApiResponse<Void> delete(@PathVariable String id) {
        Site site = siteRepository.findById(id)
                .orElseThrow(() -> new ApiException("SITE_NOT_FOUND", "사이트를 찾을 수 없습니다", HttpStatus.NOT_FOUND));
        siteRepository.delete(site);
        log.info("Site deleted: {} ({})", site.getName(), site.getId());
        return ApiResponse.ok(null);
    }
}

package com.ksinfo.modernize_pro_data.coordinator.api;

import com.ksinfo.modernize_pro_data.common.dto.ApiResponse;
import com.ksinfo.modernize_pro_data.common.exception.ApiException;
import com.ksinfo.modernize_pro_data.coordinator.ddl.DialectUtil;
import com.ksinfo.modernize_pro_data.coordinator.load.charset.TargetCharsetMapper;
import com.ksinfo.modernize_pro_data.coordinator.site.Project;
import com.ksinfo.modernize_pro_data.coordinator.site.ProjectRepository;
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
    private final ProjectRepository projectRepository;

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
            String tobeDbScope,
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
            String tobeDbScope,
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
        validateTobeEncoding(req.tobeEncoding(), req.tobeDbByEnv());
        Site site = Site.create(
                req.name(), req.asisEnv(), req.tobeEnv(),
                req.asisEncoding(), req.tobeEncoding(),
                req.csvPath(), req.notes(), req.environment(),
                req.tobeDbByEnv(), req.tobeDbLocks(),
                auth.getName()
        );
        if (req.asisDbType() != null)    site.setAsisDbType(req.asisDbType());
        if (req.asisDbVersion() != null) site.setAsisDbVersion(req.asisDbVersion());
        if (req.tobeDbScope() != null && !req.tobeDbScope().isEmpty()) {
            site.setTobeDbScope(req.tobeDbScope());
        }
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

        // scope 전환: site → project 면 Site 의 tobeDbByEnv/Locks 를 그 Site 의 모든 Project 에 복사
        // (Map 참조 공유 방지를 위해 새 LinkedHashMap 으로 깊은 복사 1단계).
        if (req.tobeDbScope() != null && !req.tobeDbScope().isEmpty()) {
            String prevScope = site.getTobeDbScope();
            String newScope = req.tobeDbScope();
            site.setTobeDbScope(newScope);
            if (!"project".equals(prevScope) && "project".equals(newScope)) {
                Map<String, Object> siteDb = site.getTobeDbByEnv() != null ? site.getTobeDbByEnv() : Map.of();
                Map<String, Boolean> siteLocks = site.getTobeDbLocks() != null ? site.getTobeDbLocks() : Map.of();
                List<Project> projects = projectRepository.findBySiteId(site.getId());
                for (Project p : projects) {
                    p.setTobeDbByEnv(new java.util.LinkedHashMap<>(siteDb));
                    p.setTobeDbLocks(new java.util.LinkedHashMap<>(siteLocks));
                    projectRepository.save(p);
                }
                log.info("Site {} scope: site -> project; copied TO-BE DB to {} projects",
                        site.getId(), projects.size());
            }
        }

        // 최종 상태(변경 반영 후)의 tobeEncoding × 엔진 조합 검증.
        validateTobeEncoding(site.getTobeEncoding(), site.getTobeDbByEnv());
        siteRepository.save(site);
        log.info("Site updated: {} ({})", site.getName(), site.getId());
        return ApiResponse.ok(site);
    }

    /**
     * tobeEncoding 이 tobeDbByEnv 의 각 엔진에 유효한지 검증 (Phase 6). PostgreSQL 은 UTF-8 만(도구 경로가
     * UTF-8 고정), Oracle 은 {@link TargetCharsetMapper} 지원 집합(JA16SJIS/JA16EUC/AL32UTF8 + 별칭).
     * 그 외 엔진(적재 미지원)은 검증 skip. 잘못된 조합은 400 으로 조기 차단 — 적재 시점 실패보다 낫다.
     */
    private void validateTobeEncoding(String tobeEncoding, Map<String, Object> tobeDbByEnv) {
        if (tobeEncoding == null || tobeEncoding.isBlank() || tobeDbByEnv == null) return;
        for (Map.Entry<String, Object> e : tobeDbByEnv.entrySet()) {
            if (!(e.getValue() instanceof Map<?, ?> cfg)) continue;
            Object type = cfg.get("type");
            String raw = type == null ? null : type.toString();
            String dialect = (raw == null || raw.isBlank())
                    ? DialectUtil.POSTGRESQL : DialectUtil.normalize(raw);
            if (DialectUtil.ORACLE.equals(dialect)) {
                if (TargetCharsetMapper.find(tobeEncoding).isEmpty()) {
                    throw new ApiException("TOBE_ENCODING_UNSUPPORTED",
                            "Oracle TO-BE(env=" + e.getKey() + ")는 tobeEncoding=" + tobeEncoding
                                    + " 를 지원하지 않습니다. 지원: AL32UTF8/UTF-8, JA16SJIS/Shift_JIS, JA16EUC/EUC-JP",
                            HttpStatus.BAD_REQUEST);
                }
            } else if (DialectUtil.POSTGRESQL.equals(dialect)) {
                String u = tobeEncoding.trim().toUpperCase();
                if (!(u.equals("UTF-8") || u.equals("UTF8"))) {
                    throw new ApiException("TOBE_ENCODING_UNSUPPORTED",
                            "PostgreSQL TO-BE(env=" + e.getKey() + ")는 UTF-8 만 지원합니다 (tobeEncoding="
                                    + tobeEncoding + ")",
                            HttpStatus.BAD_REQUEST);
                }
            }
            // 그 외 엔진(mssql/mysql/db2)은 적재 미지원 — 인코딩 검증 skip.
        }
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

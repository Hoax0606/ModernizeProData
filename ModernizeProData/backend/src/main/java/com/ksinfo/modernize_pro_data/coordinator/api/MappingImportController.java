package com.ksinfo.modernize_pro_data.coordinator.api;

import com.ksinfo.modernize_pro_data.common.dto.ApiResponse;
import com.ksinfo.modernize_pro_data.common.exception.ApiException;
import com.ksinfo.modernize_pro_data.coordinator.mapping.MappingCodeMap;
import com.ksinfo.modernize_pro_data.coordinator.mapping.MappingCodeMapRepository;
import com.ksinfo.modernize_pro_data.coordinator.mapping.MappingImport;
import com.ksinfo.modernize_pro_data.coordinator.mapping.MappingImportRepository;
import com.ksinfo.modernize_pro_data.coordinator.mapping.MappingImportService;
import com.ksinfo.modernize_pro_data.coordinator.mapping.MappingRule;
import com.ksinfo.modernize_pro_data.coordinator.mapping.MappingRuleRepository;
import com.ksinfo.modernize_pro_data.coordinator.mapping.MappingTableBinding;
import com.ksinfo.modernize_pro_data.coordinator.mapping.MappingTableBindingRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.HttpStatus;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.security.core.Authentication;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.multipart.MultipartFile;

import java.io.IOException;
import java.util.List;

/**
 * 맵핑정의서 (CSV) 임포트·조회 API.
 *
 * POST   /api/v1/projects/{id}/mapping/import     — column_mapping.csv (+ optional code_mapping.csv) 업로드
 * GET    /api/v1/projects/{id}/mapping/rules      — 현재 활성 룰 전체
 * GET    /api/v1/projects/{id}/mapping/code-maps  — 코드값 변환 전체
 * GET    /api/v1/projects/{id}/mapping/imports    — 임포트 이력
 */
@Slf4j
@RestController
@RequestMapping("/api/v1/projects")
@RequiredArgsConstructor
public class MappingImportController {

    private static final long MAX_FILE_SIZE = 50L * 1024 * 1024; // 50MB

    private final MappingImportService importService;
    private final MappingImportRepository importRepo;
    private final MappingRuleRepository ruleRepo;
    private final MappingCodeMapRepository codeRepo;
    private final MappingTableBindingRepository bindingRepo;

    @PostMapping(path = "/{id}/mapping/import", consumes = "multipart/form-data")
    @PreAuthorize("hasAnyRole('MASTER','ADMIN')")
    public ApiResponse<MappingImport> importMapping(
            @PathVariable String id,
            @RequestParam(name = "columnMapping", required = false) MultipartFile columnMapping,
            @RequestParam(name = "codeMapping", required = false) MultipartFile codeMapping,
            Authentication auth
    ) {
        boolean hasColumn = columnMapping != null && !columnMapping.isEmpty();
        boolean hasCode   = codeMapping   != null && !codeMapping.isEmpty();
        if (!hasColumn && !hasCode) {
            throw new ApiException("FILE_EMPTY",
                    "column 또는 code 매핑정의서 중 적어도 하나는 업로드해야 합니다", HttpStatus.BAD_REQUEST);
        }
        if (hasColumn && columnMapping.getSize() > MAX_FILE_SIZE) {
            throw new ApiException("FILE_TOO_LARGE",
                    "column_mapping 파일이 너무 큽니다 (max 50MB)", HttpStatus.BAD_REQUEST);
        }
        if (hasCode && codeMapping.getSize() > MAX_FILE_SIZE) {
            throw new ApiException("FILE_TOO_LARGE",
                    "code_mapping 파일이 너무 큽니다 (max 50MB)", HttpStatus.BAD_REQUEST);
        }

        byte[] columnBytes = null;
        byte[] codeBytes = null;
        try {
            if (hasColumn) columnBytes = columnMapping.getBytes();
            if (hasCode)   codeBytes   = codeMapping.getBytes();
        } catch (IOException e) {
            throw new ApiException("FILE_READ_FAILED",
                    "파일 읽기 실패: " + e.getMessage(), HttpStatus.BAD_REQUEST);
        }

        MappingImport result = importService.importFromCsv(
                id,
                columnBytes,
                hasColumn ? columnMapping.getOriginalFilename() : null,
                codeBytes,
                hasCode ? codeMapping.getOriginalFilename() : null,
                auth.getName());
        return ApiResponse.ok(result);
    }

    @GetMapping("/{id}/mapping/rules")
    public ApiResponse<List<MappingRule>> listRules(@PathVariable String id) {
        return ApiResponse.ok(ruleRepo.findByProjectId(id));
    }

    @PostMapping("/{id}/mapping/rules")
    @PreAuthorize("hasAnyRole('MASTER','ADMIN')")
    public ApiResponse<MappingRule> upsertRule(
            @PathVariable String id,
            @RequestBody MappingImportService.UpsertRuleRequest req,
            Authentication auth
    ) {
        return ApiResponse.ok(importService.upsertRule(id, req, auth.getName()));
    }

    @GetMapping("/{id}/mapping/code-maps")
    public ApiResponse<List<MappingCodeMap>> listCodeMaps(@PathVariable String id) {
        return ApiResponse.ok(codeRepo.findByProjectIdOrderByDomainAscOrdinalAsc(id));
    }

    @GetMapping("/{id}/mapping/imports")
    public ApiResponse<List<MappingImport>> listImports(@PathVariable String id) {
        return ApiResponse.ok(importRepo.findByProjectIdOrderByImportedAtDesc(id));
    }

    /** 현재 활성 상태 — rules/code_maps 가 실제로 존재하면 그 슬롯의 최신 파일명을 반환. */
    public record MappingStatus(
            String columnFilename,
            String codeFilename,
            long ruleCount,
            long codeMapCount
    ) {}

    @GetMapping("/{id}/mapping/status")
    public ApiResponse<MappingStatus> status(@PathVariable String id) {
        long ruleCount = ruleRepo.countByProjectId(id);
        long codeCount = codeRepo.countByProjectId(id);
        List<MappingImport> history = importRepo.findByProjectIdOrderByImportedAtDesc(id);
        String columnFilename = ruleCount > 0
                ? history.stream().map(MappingImport::getFilename).filter(java.util.Objects::nonNull).findFirst().orElse(null)
                : null;
        String codeFilename = codeCount > 0
                ? history.stream().map(MappingImport::getCodeFilename).filter(java.util.Objects::nonNull).findFirst().orElse(null)
                : null;
        return ApiResponse.ok(new MappingStatus(columnFilename, codeFilename, ruleCount, codeCount));
    }

    @DeleteMapping("/{id}/mapping/rules")
    @PreAuthorize("hasAnyRole('MASTER','ADMIN')")
    @Transactional
    public ApiResponse<Void> deleteRules(@PathVariable String id) {
        ruleRepo.deleteAllByProjectId(id);
        return ApiResponse.ok(null);
    }

    @DeleteMapping("/{id}/mapping/code-maps")
    @PreAuthorize("hasAnyRole('MASTER','ADMIN')")
    @Transactional
    public ApiResponse<Void> deleteCodeMaps(@PathVariable String id) {
        codeRepo.deleteAllByProjectId(id);
        return ApiResponse.ok(null);
    }

    @GetMapping("/{id}/mapping/bindings")
    public ApiResponse<List<MappingTableBinding>> listBindings(@PathVariable String id) {
        return ApiResponse.ok(bindingRepo.findByProjectId(id));
    }

    @PostMapping("/{id}/mapping/rebuild-bindings")
    @PreAuthorize("hasAnyRole('MASTER','ADMIN')")
    public ApiResponse<Integer> rebuildBindings(@PathVariable String id, Authentication auth) {
        int n = importService.rebuildBindings(id, auth.getName());
        return ApiResponse.ok(n);
    }

    /** 가장 최근 임포트의 CSV 내용으로 룰·코드맵·바인딩 모두 재적용 (수동 수정 reset). */
    @PostMapping("/{id}/mapping/reapply")
    @PreAuthorize("hasAnyRole('MASTER','ADMIN')")
    public ApiResponse<MappingImport> reapplyLatest(@PathVariable String id, Authentication auth) {
        return ApiResponse.ok(importService.reapplyLatest(id, auth.getName()));
    }

    @PostMapping("/{id}/mapping/bindings")
    @PreAuthorize("hasAnyRole('MASTER','ADMIN')")
    public ApiResponse<MappingTableBinding> upsertBinding(
            @PathVariable String id,
            @RequestBody MappingImportService.UpsertBindingRequest req,
            Authentication auth
    ) {
        return ApiResponse.ok(importService.upsertBinding(id, req, auth.getName()));
    }

    @DeleteMapping("/{id}/mapping/bindings")
    @PreAuthorize("hasAnyRole('MASTER','ADMIN')")
    @Transactional
    public ApiResponse<Void> deleteBindings(@PathVariable String id) {
        bindingRepo.deleteAllByProjectId(id);
        return ApiResponse.ok(null);
    }
}

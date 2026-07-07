package com.ksinfo.modernize_pro_data.coordinator.api;

import com.ksinfo.modernize_pro_data.common.dto.ApiResponse;
import com.ksinfo.modernize_pro_data.common.exception.ApiException;
import com.ksinfo.modernize_pro_data.coordinator.mapping.SiteMappingImportService;
import com.ksinfo.modernize_pro_data.coordinator.mapping.SiteMappingImportService.SiteImportResult;

import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.HttpStatus;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.multipart.MultipartFile;

import java.io.IOException;
import java.util.List;

/**
 * 사이트 단위 맵핑정의서 일괄 import API.
 *
 * POST /api/v1/sites/{siteId}/mapping/import — 하나의 column/code CSV 를 사이트의
 *   프로젝트들(projectIds 미지정 시 전체)에 분배. per-project import 를 재사용.
 */
@Slf4j
@RestController
@RequestMapping("/api/v1/sites")
@RequiredArgsConstructor
public class SiteMappingImportController {

    private static final long MAX_FILE_SIZE = 50L * 1024 * 1024; // 50MB

    private final SiteMappingImportService siteImportService;

    @PostMapping(path = "/{siteId}/mapping/import", consumes = "multipart/form-data")
    @PreAuthorize("hasAnyRole('MASTER','ADMIN')")
    public ApiResponse<SiteImportResult> importSiteMapping(
            @PathVariable String siteId,
            @RequestParam(name = "columnMapping", required = false) MultipartFile columnMapping,
            @RequestParam(name = "codeMapping", required = false) MultipartFile codeMapping,
            @RequestParam(name = "projectIds", required = false) List<String> projectIds,
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

        SiteImportResult result = siteImportService.importForSite(
                siteId,
                projectIds,
                columnBytes,
                hasColumn ? columnMapping.getOriginalFilename() : null,
                codeBytes,
                hasCode ? codeMapping.getOriginalFilename() : null,
                auth.getName());
        return ApiResponse.ok(result);
    }
}

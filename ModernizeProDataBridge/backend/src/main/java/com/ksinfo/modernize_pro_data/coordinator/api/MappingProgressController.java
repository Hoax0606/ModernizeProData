package com.ksinfo.modernize_pro_data.coordinator.api;

import com.ksinfo.modernize_pro_data.common.dto.ApiResponse;
import com.ksinfo.modernize_pro_data.coordinator.mapping.MappingProgressService;
import com.ksinfo.modernize_pro_data.coordinator.mapping.MappingProgressService.ProjectMappingProgress;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

/**
 * Site Overview 의 프로젝트별 매핑 진행률 — 한 번에 집계 (2026-06-04).
 * 기존 FE 의 N×3 (DDL/rules/bindings) 라운드트립을 1 호출로 대체.
 *   GET /api/v1/sites/{siteId}/mapping-progress
 */
@RestController
@RequiredArgsConstructor
public class MappingProgressController {

    private final MappingProgressService mappingProgressService;

    @GetMapping("/api/v1/sites/{siteId}/mapping-progress")
    public ApiResponse<List<ProjectMappingProgress>> bySite(@PathVariable String siteId) {
        return ApiResponse.ok(mappingProgressService.forSite(siteId));
    }
}

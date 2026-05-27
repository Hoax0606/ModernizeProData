package com.ksinfo.modernize_pro_data.coordinator.api;

import com.ksinfo.modernize_pro_data.common.dto.ApiResponse;
import com.ksinfo.modernize_pro_data.coordinator.run.ExecutionOverviewService;
import com.ksinfo.modernize_pro_data.coordinator.run.ExecutionOverviewService.ProjectExecMetrics;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

/**
 * All projects 화면(/site/execution)의 execution overview 지표 — per-project 최신 run 집계.
 * user session 認証.
 */
@RestController
@RequiredArgsConstructor
public class ExecutionOverviewController {

    private final ExecutionOverviewService overviewService;

    @GetMapping("/api/v1/sites/{siteId}/execution-overview")
    public ApiResponse<List<ProjectExecMetrics>> bySite(@PathVariable String siteId) {
        return ApiResponse.ok(overviewService.bySite(siteId));
    }
}

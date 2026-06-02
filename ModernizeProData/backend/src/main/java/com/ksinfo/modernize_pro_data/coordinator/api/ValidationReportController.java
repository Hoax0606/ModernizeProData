package com.ksinfo.modernize_pro_data.coordinator.api;

import com.ksinfo.modernize_pro_data.common.dto.ApiResponse;
import com.ksinfo.modernize_pro_data.common.exception.ApiException;
import com.ksinfo.modernize_pro_data.coordinator.run.validation.ValidationDiffSampleDto;
import com.ksinfo.modernize_pro_data.coordinator.run.validation.ValidationDiffService;
import com.ksinfo.modernize_pro_data.coordinator.run.validation.ValidationReportDto;
import com.ksinfo.modernize_pro_data.coordinator.run.validation.ValidationReportService;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.HttpStatus;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

/**
 * Validation report 조회 API — ArtifactsPage 의 Validation 카테고리가 호출.
 *
 * GET /api/v1/runs/{runId}/validation                  — 전체 binding 목록
 * GET /api/v1/runs/{runId}/validation/{bindingId}      — 단일 binding 상세
 * GET /api/v1/runs/{runId}/validation/by-table?tobeTable={name}
 *                                                       — TO-BE 물리명 fallback (binding 1:1 가정)
 *
 * Auth: user session (master/admin/normal). Quarantine endpoint 와 동일 기준 — run 을 볼 수
 * 있는 role 은 누구나 validation 도 볼 수 있어야.
 */
@Slf4j
@RestController
@RequiredArgsConstructor
public class ValidationReportController {

    private final ValidationReportService reportService;
    private final ValidationDiffService diffService;

    @GetMapping("/api/v1/runs/{runId}/validation")
    @PreAuthorize("isAuthenticated()")
    public ApiResponse<List<ValidationReportDto>> listByRun(@PathVariable String runId) {
        return ApiResponse.ok(reportService.listByRun(runId));
    }

    @GetMapping("/api/v1/runs/{runId}/validation/{bindingId}")
    @PreAuthorize("isAuthenticated()")
    public ApiResponse<ValidationReportDto> getByBinding(@PathVariable String runId,
                                                         @PathVariable String bindingId) {
        return ApiResponse.ok(reportService.findByRunAndBinding(runId, bindingId)
                .orElseThrow(() -> new ApiException("VALIDATION_NOT_FOUND",
                        "Validation report not found for run=" + runId + " binding=" + bindingId,
                        HttpStatus.NOT_FOUND)));
    }

    /**
     * TO-BE 物理 테이블명으로 조회. FE 가 binding ID 추적을 안 해도 selectedTable 만으로
     * 접근 가능 — binding 1:1 mapping 가정. shared mapping 등으로 모호하면 첫 매칭 반환.
     */
    /**
     * Drill-down — Data Integrity Check (SHA-256) FAIL 시 어느 row 가 다른지 row-by-row 비교.
     * PK 기반 매칭 + 컬럼 비교. 한 요청당 최대 200 row (BE 부담 제한).
     */
    @GetMapping("/api/v1/runs/{runId}/validation/{bindingId}/diff-sample")
    @PreAuthorize("isAuthenticated()")
    public ApiResponse<ValidationDiffSampleDto> getDiffSample(@PathVariable String runId,
                                                              @PathVariable String bindingId,
                                                              @RequestParam(defaultValue = "50") int limit) {
        return ApiResponse.ok(diffService.fetchDiff(runId, bindingId, limit));
    }

    @GetMapping("/api/v1/runs/{runId}/validation/by-table")
    @PreAuthorize("isAuthenticated()")
    public ApiResponse<ValidationReportDto> getByTable(@PathVariable String runId,
                                                       @RequestParam String tobeTable) {
        return ApiResponse.ok(reportService.findByRunAndTobeTable(runId, tobeTable)
                .orElseThrow(() -> new ApiException("VALIDATION_NOT_FOUND",
                        "Validation report not found for run=" + runId + " table=" + tobeTable,
                        HttpStatus.NOT_FOUND)));
    }
}

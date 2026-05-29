package com.ksinfo.modernize_pro_data.coordinator.run.validation;

import java.time.OffsetDateTime;
import java.util.List;
import java.util.Map;

/**
 * Validation report 응답 DTO — FE 가 그대로 Cell[][] 로 변환 가능한 raw shape.
 *
 * 시트별 array (overview / sumRecon / nullParity / minMax / typeValid) 는 Map<String,Object>
 * 그대로 ─ JSONB 의 keys 와 1:1. FE 의 변환 함수가 column header 와 row 순서를 결정.
 *
 * status: 'success' = 정상 / 'failed' = 계산 자체 실패 (errorSummary 사용).
 */
public record ValidationReportDto(
        String runId,
        String bindingId,
        String tobeSchema,
        String tobeTable,
        OffsetDateTime generatedAt,
        int totalChecks,
        int passedChecks,
        String status,             // 'success' or 'failed'
        String errorSummary,       // null on success

        /* Sheet shapes — keys 는 ValidationReportService 가 채운 그대로. */
        List<Map<String, Object>> overview,
        List<Map<String, Object>> sumRecon,
        List<Map<String, Object>> nullParity,
        List<Map<String, Object>> minMax,
        List<Map<String, Object>> typeValid,
        Map<String, Object> rowCount,
        Map<String, Object> checksum
) {
    @SuppressWarnings("unchecked")
    public static ValidationReportDto from(ValidationReport r) {
        Map<String, Object> d = r.getReportData() == null ? Map.of() : r.getReportData();
        return new ValidationReportDto(
                r.getRunId(),
                r.getBindingId(),
                r.getTobeSchema(),
                r.getTobeTable(),
                r.getGeneratedAt(),
                r.getTotalChecks(),
                r.getPassedChecks(),
                r.getErrorSummary() == null ? "success" : "failed",
                r.getErrorSummary(),
                (List<Map<String, Object>>) d.getOrDefault("overview", List.of()),
                (List<Map<String, Object>>) d.getOrDefault("sumRecon", List.of()),
                (List<Map<String, Object>>) d.getOrDefault("nullParity", List.of()),
                (List<Map<String, Object>>) d.getOrDefault("minMax", List.of()),
                (List<Map<String, Object>>) d.getOrDefault("typeValid", List.of()),
                (Map<String, Object>) d.getOrDefault("rowCount", Map.of()),
                (Map<String, Object>) d.getOrDefault("checksum", Map.of())
        );
    }
}

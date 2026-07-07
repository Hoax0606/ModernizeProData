package com.ksinfo.modernize_pro_data.coordinator.run.validation;

import java.util.List;

/**
 * Validation drill-down — Data Integrity Check (SHA-256 checksum) FAIL 시 어느 row 가 다른지
 * row-by-row 비교 결과. DuckDB tobe_ (AS-IS 변환 후) vs PG tobe (적재 후) PK 기반 매칭.
 *
 * status 의미:
 *   - "asis-only"  : DuckDB 에는 있는데 PG 에는 없는 row (적재 실패 / Audit 격리)
 *   - "tobe-only"  : PG 에는 있는데 DuckDB 에는 없는 row (재실행 / 외부 입력 등)
 *   - "value-diff" : PK 는 일치, 일부 컬럼 값 다름
 */
public record ValidationDiffSampleDto(
        String runId,
        String bindingId,
        List<String> pkColumns,
        int limit,
        int totalDiff,
        String note,           // "no PK — diff requires PK" 같은 운영 메시지
        List<DiffRow> rows
) {
    public record DiffRow(
            List<Object> pk,           // PK 컬럼 값들 (pkColumns 순서)
            String status,             // "asis-only" / "tobe-only" / "value-diff"
            List<ColumnDiff> diffs     // status="value-diff" 일 때만 채워짐
    ) {}

    public record ColumnDiff(
            String column,
            Object asisValue,
            Object tobeValue
    ) {}
}

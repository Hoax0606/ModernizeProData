package com.ksinfo.modernize_pro_data.coordinator.site.frozen;

import java.time.OffsetDateTime;
import java.util.List;
import java.util.Map;

/**
 * Snapshot 에 박제되는 run 실행 컨텍스트.
 *
 * run_history.snapshot_id 가 있는 run 이 terminal (success/failed/aborted/timed_out) 상태로
 * 종료될 때 {@code RunService.finishRun} → {@code SnapshotExecutionContextService} 가 그
 * snapshot 의 execution_context 를 이 shape 으로 갱신한다.
 *
 * 같은 snapshot 으로 여러 번 run 하면 매번 덮어쓴다 (사용자 결정 — "그 run 이 끝나면 그때
 * 이행 진행된 상황을 freeze"). 옛 snapshot 은 null.
 *
 * frontend `ExecutionPage` (pipeline stages) + `LogViewer` (run_id 로 logs) + `ArtifactsPage`
 * (success table 필터 + MIGRATION SQL 박제본) 이 snapshot view 모드일 때 live run 대신 이
 * 컨텍스트를 source 로 사용해 "그 snapshot 시점" 으로 시간 여행 표시.
 */
public record SnapshotExecutionContext(
        String runId,
        String runType,            // test / rehearsal / cutover
        String status,             // success / failed / aborted / timed_out
        OffsetDateTime startedAt,
        OffsetDateTime finishedAt,
        Long durationMs,
        List<StageSnapshot> stages
) {
    public record StageSnapshot(
            String stageKey,
            Integer seq,
            String status,
            Integer pct,
            Integer tablesTotal,
            Integer tablesSuccess,
            Integer tablesFailed,
            OffsetDateTime startedAt,
            OffsetDateTime finishedAt,
            Long durationMs,
            String errorSummary,
            List<TableSnapshot> tables
    ) {}

    public record TableSnapshot(
            String bindingId,
            String tobeSchema,
            String tobeTable,
            String status,
            Long rowCount,
            Integer errorCount,
            Map<String, Object> errorDetail,
            OffsetDateTime startedAt,
            OffsetDateTime finishedAt,
            Long durationMs,
            /** Load stage 의 합성 SQL — MIGRATION SQL artifact 에서 직접 표시. transform 외 stage 는 null. */
            String compiledSql
    ) {}
}

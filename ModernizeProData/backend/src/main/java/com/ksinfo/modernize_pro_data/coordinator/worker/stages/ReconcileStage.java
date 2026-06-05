package com.ksinfo.modernize_pro_data.coordinator.worker.stages;

import com.ksinfo.modernize_pro_data.common.duckdb.DuckDbService;
import com.ksinfo.modernize_pro_data.coordinator.mapping.MappingTableBinding;
import com.ksinfo.modernize_pro_data.coordinator.quarantine.QuarantineService;
import com.ksinfo.modernize_pro_data.coordinator.run.stage.StageInstance;
import com.ksinfo.modernize_pro_data.coordinator.run.stage.StageInstanceRepository;
import com.ksinfo.modernize_pro_data.coordinator.run.stage.StageStatus;
import com.ksinfo.modernize_pro_data.coordinator.run.stage.StageTableResult;
import com.ksinfo.modernize_pro_data.coordinator.run.stage.StageTableResultRepository;
import com.ksinfo.modernize_pro_data.coordinator.run.stage.StageTableStatus;
import com.ksinfo.modernize_pro_data.coordinator.runlog.RunLogIngestService;
import com.ksinfo.modernize_pro_data.coordinator.worker.StageContext;
import com.ksinfo.modernize_pro_data.coordinator.worker.StageHelpers;
import com.ksinfo.modernize_pro_data.coordinator.worker.StageProgressBroadcaster;
import com.ksinfo.modernize_pro_data.coordinator.worker.StageRunner;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

import java.sql.ResultSet;
import java.sql.Statement;
import java.time.Duration;
import java.time.OffsetDateTime;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Reconcile stage — AS-IS sanity check.
 *
 * PoC 1차 단순화: 각 binding 의 asis_{table} row_count 측정 (sanity check).
 * duplicate key 검출은 PoC 2차 (PK 정보 필요).
 */
@Service
@RequiredArgsConstructor
@Slf4j
public class ReconcileStage implements StageRunner {

    private static final String STAGE_KEY = "reconcile";

    private final StageInstanceRepository stageInstanceRepo;
    private final StageTableResultRepository stageTableResultRepo;
    private final DuckDbService duckDbService;
    private final QuarantineService quarantineService;
    private final RunLogIngestService runLogIngest;
    private final StageProgressBroadcaster broadcaster;

    @Override
    public String stageKey() {
        return STAGE_KEY;
    }

    @Override
    public void run(StageContext ctx, StageInstance stage) {
        OffsetDateTime startedAt = OffsetDateTime.now();
        stage.setStatus(StageStatus.running);
        stage.setStartedAt(startedAt);
        stageInstanceRepo.save(stage);

        String runId = ctx.getRunHistory().getId();
        String schema = ctx.getDuckdbSchema();
        ingest(ctx, "Stage reconcile started — " + ctx.getBindings().size() + " bindings", true);

        int successCount = 0;
        int failedCount = 0;

        for (MappingTableBinding binding : ctx.getBindings()) {
            ctx.throwIfCancelled();   // abort/timeout 신호 시 RunCancelledException → LocalWorkerExecutor 가 stage failed 마킹.
            OffsetDateTime tableStart = OffsetDateTime.now();
            String tobeSchema = binding.getTobeSchema() == null ? "" : binding.getTobeSchema();
            String tobeTable  = binding.getTobeTable();
            String tableLabel = tobeSchema.isBlank() ? tobeTable : tobeSchema + "." + tobeTable;

            StageTableResult result = stageTableResultRepo
                    .findByStageInstanceIdAndBindingId(stage.getId(), binding.getId())
                    .orElseGet(() -> StageTableResult.create(stage.getId(), binding.getId(), tobeSchema, tobeTable));
            result.setStartedAt(tableStart);

            try {
                // binding 의 각 distinct AS-IS source 테이블 row count 합산.
                java.util.Set<String> asisTables = new java.util.LinkedHashSet<>();
                for (var src : binding.getSources()) {
                    if (src.getAsisTable() != null && !src.getAsisTable().isBlank()) {
                        asisTables.add(src.getAsisTable());
                    }
                }
                long rowCount = 0;
                for (String asisTable : asisTables) {
                    String fqAsis = quoteIdent(schema) + "." + quoteIdent("asis_" + asisTable);
                    try (Statement st = duckDbService.statement();
                         ResultSet rs = st.executeQuery("SELECT COUNT(*) FROM " + fqAsis)) {
                        rs.next();
                        rowCount += rs.getLong(1);
                    }
                }

                result.setStatus(StageTableStatus.success);
                result.setRowCount(rowCount);
                OffsetDateTime tableEnd = OffsetDateTime.now();
                result.setFinishedAt(tableEnd);
                result.setDurationMs(Duration.between(tableStart, tableEnd).toMillis());
                stageTableResultRepo.save(result);

                ingest(ctx, "Reconciled " + tobeTable + ": " + rowCount + " rows", true);
                successCount++;
                stage.setTablesSuccess(successCount);
                stage.setTablesFailed(failedCount);
                stageInstanceRepo.save(stage);
                broadcaster.stageProgress(runId, stage);
            } catch (Exception e) {
                result.setStatus(StageTableStatus.failed);
                Map<String, Object> detail = new HashMap<>();
                detail.put("message", e.getMessage());
                result.setErrorDetail(detail);
                OffsetDateTime tableEnd = OffsetDateTime.now();
                result.setFinishedAt(tableEnd);
                result.setDurationMs(Duration.between(tableStart, tableEnd).toMillis());
                stageTableResultRepo.save(result);

                /* Step 1 — binding-level 실패를 Quarantine 카드로 노출. */
                StageHelpers.recordStageFailureQuarantine(ctx, quarantineService, stage, binding,
                        tableLabel, "Reconcile", "reconcile.failure", e.getMessage());

                ingest(ctx, "Reconcile failed for " + tableLabel + ": " + e.getMessage(), false);
                failedCount++;
                stage.setTablesSuccess(successCount);
                stage.setTablesFailed(failedCount);
                stageInstanceRepo.save(stage);
                broadcaster.stageProgress(runId, stage);
            }
        }

        OffsetDateTime finishedAt = OffsetDateTime.now();
        stage.setFinishedAt(finishedAt);
        stage.setDurationMs(Duration.between(startedAt, finishedAt).toMillis());
        stage.setTablesSuccess(successCount);
        stage.setTablesFailed(failedCount);
        stage.setStatus(failedCount == 0 ? StageStatus.success : StageStatus.failed);
        stageInstanceRepo.save(stage);

        ingest(ctx, "Stage reconcile completed — " + successCount + " success, " + failedCount + " failed", true);
        log.info("ReconcileStage success={} failed={}", successCount, failedCount);
    }

    private void ingest(StageContext ctx, String message, boolean info) {
        long seq = ctx.nextLogSeq();
        var line = info
                ? StageHelpers.info(seq, ctx.getRunHistory().getId(), STAGE_KEY, message)
                : StageHelpers.error(seq, ctx.getRunHistory().getId(), STAGE_KEY, message);
        runLogIngest.ingest(ctx.getRunHistory().getId(), ctx.getProject().getId(), List.of(line));
    }

    private static String quoteIdent(String name) {
        return "\"" + name.replace("\"", "\"\"") + "\"";
    }
}

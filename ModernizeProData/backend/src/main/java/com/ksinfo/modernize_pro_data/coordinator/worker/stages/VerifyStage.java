package com.ksinfo.modernize_pro_data.coordinator.worker.stages;

import com.ksinfo.modernize_pro_data.common.duckdb.DuckDbService;
import com.ksinfo.modernize_pro_data.coordinator.load.PgCopyManager;
import com.ksinfo.modernize_pro_data.coordinator.mapping.MappingTableBinding;
import com.ksinfo.modernize_pro_data.coordinator.quarantine.QuarantineService;
import com.ksinfo.modernize_pro_data.coordinator.quarantine.QuarantineSeverity;
import com.ksinfo.modernize_pro_data.coordinator.run.stage.StageInstance;
import com.ksinfo.modernize_pro_data.coordinator.run.stage.StageInstanceRepository;
import com.ksinfo.modernize_pro_data.coordinator.run.stage.StageStatus;
import com.ksinfo.modernize_pro_data.coordinator.run.stage.StageTableResult;
import com.ksinfo.modernize_pro_data.coordinator.run.stage.StageTableResultRepository;
import com.ksinfo.modernize_pro_data.coordinator.run.stage.StageTableStatus;
import com.ksinfo.modernize_pro_data.coordinator.runlog.RunLogIngestService;
import com.ksinfo.modernize_pro_data.coordinator.site.Site;
import com.ksinfo.modernize_pro_data.coordinator.worker.StageContext;
import com.ksinfo.modernize_pro_data.coordinator.worker.StageHelpers;
import com.ksinfo.modernize_pro_data.coordinator.worker.StageRunner;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

import java.sql.Connection;
import java.sql.ResultSet;
import java.sql.Statement;
import java.time.Duration;
import java.time.OffsetDateTime;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Verify stage — TO-BE DB row_count vs DuckDB tobe_xxx (Transform 결과) 비교.
 *
 * PoC 1차 단순화:
 *   - DuckDB tobe_{table} 의 row_count (Transform 후 결과)
 *   - PostgreSQL {tobe_table} 의 row_count (Load 후 결과)
 *   - 같으면 success, 다르면 quarantine (severity=error) + stage fail
 *
 * 추후: 샘플 row hash 비교, column 별 distinct count 비교 등.
 */
@Service
@RequiredArgsConstructor
@Slf4j
public class VerifyStage implements StageRunner {

    private static final String STAGE_KEY = "verify";

    private final StageInstanceRepository stageInstanceRepo;
    private final StageTableResultRepository stageTableResultRepo;
    private final DuckDbService duckDbService;
    private final PgCopyManager pgCopyManager;
    private final QuarantineService quarantineService;
    private final RunLogIngestService runLogIngest;

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

        Site site = ctx.getSite();
        String schema = ctx.getDuckdbSchema();
        ingest(ctx, "Stage verify started — " + ctx.getBindings().size() + " bindings", true);

        @SuppressWarnings("unchecked")
        Map<String, Object> dbConfig = (Map<String, Object>) site.getTobeDbByEnv().get(site.getTobeEnv());
        if (dbConfig == null) {
            failStage(stage, startedAt, 0, ctx.getBindings().size(), "tobe DB config not set");
            ingest(ctx, "Verify failed — tobe DB config not set", false);
            return;
        }

        int successCount = 0;
        int failedCount = 0;

        for (MappingTableBinding binding : ctx.getBindings()) {
            OffsetDateTime tableStart = OffsetDateTime.now();
            String tobeSchema = binding.getTobeSchema() == null ? "" : binding.getTobeSchema();
            String tobeTable  = binding.getTobeTable();

            StageTableResult result = stageTableResultRepo
                    .findByStageInstanceIdAndBindingId(stage.getId(), binding.getId())
                    .orElseGet(() -> StageTableResult.create(stage.getId(), binding.getId(), tobeSchema, tobeTable));
            result.setStartedAt(tableStart);

            try {
                long duckCount;
                String fqDuck = quoteIdent(schema) + "." + quoteIdent("tobe_" + tobeTable);
                try (Statement st = duckDbService.statement();
                     ResultSet rs = st.executeQuery("SELECT COUNT(*) FROM " + fqDuck)) {
                    rs.next();
                    duckCount = rs.getLong(1);
                }

                long pgCount;
                String pgQualified = pgTableName(tobeSchema, tobeTable);
                try (Connection conn = pgCopyManager.openConnection(dbConfig);
                     Statement st = conn.createStatement();
                     ResultSet rs = st.executeQuery("SELECT COUNT(*) FROM " + pgQualified)) {
                    rs.next();
                    pgCount = rs.getLong(1);
                }

                OffsetDateTime tableEnd = OffsetDateTime.now();
                if (duckCount != pgCount) {
                    Map<String, Object> sampleData = new HashMap<>();
                    sampleData.put("reason", "Row count mismatch");
                    sampleData.put("detail", tobeTable + ": DuckDB=" + duckCount + " vs PostgreSQL=" + pgCount);
                    sampleData.put("severity", "error");
                    sampleData.put("stageLabel", "verify.checksum");
                    sampleData.put("table", tobeTable);
                    sampleData.put("columns", List.of("source", "rowCount"));
                    sampleData.put("columnRoles", List.of("pk", "violated"));
                    sampleData.put("sampleRows", List.of(
                            List.of("DuckDB tobe", duckCount),
                            List.of("PostgreSQL", pgCount)));
                    quarantineService.record(
                            ctx.getRunHistory().getId(),
                            stage.getId(),
                            binding.getId(),
                            null,
                            "Row count mismatch — " + tobeTable,
                            QuarantineSeverity.error,
                            sampleData,
                            Math.abs(duckCount - pgCount),
                            ctx.getLogLineSeqCursor());
                    result.setStatus(StageTableStatus.failed);
                    Map<String, Object> detail = new HashMap<>();
                    detail.put("message", "DuckDB=" + duckCount + " ≠ PG=" + pgCount);
                    result.setErrorDetail(detail);
                    ingest(ctx, "Verify mismatch " + tobeTable + ": DuckDB=" + duckCount + " vs PG=" + pgCount, false);
                    failedCount++;
                } else {
                    result.setStatus(StageTableStatus.success);
                    result.setRowCount(pgCount);
                    ingest(ctx, "Verified " + tobeTable + ": " + pgCount + " rows", true);
                    successCount++;
                }
                result.setFinishedAt(tableEnd);
                result.setDurationMs(Duration.between(tableStart, tableEnd).toMillis());
                stageTableResultRepo.save(result);
            } catch (Exception e) {
                OffsetDateTime tableEnd = OffsetDateTime.now();
                result.setStatus(StageTableStatus.failed);
                Map<String, Object> detail = new HashMap<>();
                detail.put("message", e.getMessage());
                result.setErrorDetail(detail);
                result.setFinishedAt(tableEnd);
                result.setDurationMs(Duration.between(tableStart, tableEnd).toMillis());
                stageTableResultRepo.save(result);

                ingest(ctx, "Verify failed for " + tobeTable + ": " + e.getMessage(), false);
                failedCount++;
            }
        }

        OffsetDateTime finishedAt = OffsetDateTime.now();
        stage.setFinishedAt(finishedAt);
        stage.setDurationMs(Duration.between(startedAt, finishedAt).toMillis());
        stage.setTablesSuccess(successCount);
        stage.setTablesFailed(failedCount);
        stage.setStatus(failedCount == 0 ? StageStatus.success : StageStatus.failed);
        if (failedCount > 0) {
            stage.setErrorSummary(failedCount + " tables failed in verify stage");
        }
        stageInstanceRepo.save(stage);

        ingest(ctx, "Stage verify completed — " + successCount + " success, " + failedCount + " failed", true);
        log.info("VerifyStage success={} failed={}", successCount, failedCount);
    }

    private void failStage(StageInstance stage, OffsetDateTime startedAt,
                           int successCount, int failedCount, String errorSummary) {
        OffsetDateTime finishedAt = OffsetDateTime.now();
        stage.setStatus(StageStatus.failed);
        stage.setFinishedAt(finishedAt);
        stage.setDurationMs(Duration.between(startedAt, finishedAt).toMillis());
        stage.setTablesSuccess(successCount);
        stage.setTablesFailed(failedCount);
        stage.setErrorSummary(errorSummary);
        stageInstanceRepo.save(stage);
    }

    private static String pgTableName(String tobeSchema, String tobeTable) {
        if (tobeSchema == null || tobeSchema.isBlank()) {
            return "\"" + tobeTable.replace("\"", "\"\"") + "\"";
        }
        return "\"" + tobeSchema.replace("\"", "\"\"") + "\"."
             + "\"" + tobeTable.replace("\"", "\"\"") + "\"";
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

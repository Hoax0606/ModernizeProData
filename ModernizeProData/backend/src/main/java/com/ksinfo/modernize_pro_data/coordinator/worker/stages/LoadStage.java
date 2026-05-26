package com.ksinfo.modernize_pro_data.coordinator.worker.stages;

import com.ksinfo.modernize_pro_data.common.duckdb.DuckDbService;
import com.ksinfo.modernize_pro_data.coordinator.load.PgCopyManager;
import com.ksinfo.modernize_pro_data.coordinator.mapping.MappingTableBinding;
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

import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.Statement;
import java.time.Duration;
import java.time.OffsetDateTime;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Load stage — DuckDB 의 tobe_{table} → TO-BE PostgreSQL COPY.
 *
 * 흐름 (binding 별):
 *   1. DuckDB tobe_{table} → temp CSV (FORMAT CSV, HEADER false)
 *   2. PostgreSQL Connection 열기 (site.tobeDbByEnv[env])
 *   3. TRUNCATE TABLE {tobeSchema}.{tobe_table}
 *   4. CopyManager.copyIn — CSV → COPY FROM stdin
 *   5. row_count 기록 + temp CSV 삭제
 *
 * PoC 단순화:
 *   - 매 binding 별 Connection 열고 닫음 (connection pool X)
 *   - TRUNCATE 후 COPY (재실행 가능)
 *   - tobeSchema 가 비어있으면 unqualified table 명 (public schema 가정)
 */
@Service
@RequiredArgsConstructor
@Slf4j
public class LoadStage implements StageRunner {

    private static final String STAGE_KEY = "load";

    private final StageInstanceRepository stageInstanceRepo;
    private final StageTableResultRepository stageTableResultRepo;
    private final DuckDbService duckDbService;
    private final PgCopyManager pgCopyManager;
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
        ingest(ctx, "Stage load started — " + ctx.getBindings().size() + " bindings", true);

        @SuppressWarnings("unchecked")
        Map<String, Object> dbConfig = (Map<String, Object>) site.getTobeDbByEnv().get(site.getTobeEnv());
        if (dbConfig == null) {
            failStage(stage, startedAt, 0, ctx.getBindings().size(), "tobe DB config not set");
            ingest(ctx, "Load failed — tobe DB config not set", false);
            return;
        }

        Path tempDir = ctx.getOutputDir().resolve("temp");
        try {
            Files.createDirectories(tempDir);
        } catch (Exception e) {
            failStage(stage, startedAt, 0, ctx.getBindings().size(), "temp dir create failed: " + e.getMessage());
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

            Path tempCsv = tempDir.resolve(tobeTable + ".csv");
            try {
                // 1. DuckDB → temp CSV
                String fqTobeDuck = quoteIdent(schema) + "." + quoteIdent("tobe_" + tobeTable);
                String escapedCsv = tempCsv.toString().replace("\\", "/").replace("'", "''");
                try (Statement st = duckDbService.statement()) {
                    st.execute("COPY " + fqTobeDuck + " TO '" + escapedCsv + "' (FORMAT CSV, HEADER false)");
                }

                // 2. PostgreSQL Connection + TRUNCATE + COPY
                String pgQualified = pgTableName(tobeSchema, tobeTable);
                long rows;
                try (Connection conn = pgCopyManager.openConnection(dbConfig)) {
                    pgCopyManager.truncate(conn, pgQualified);
                    rows = pgCopyManager.copyInFromCsv(conn, pgQualified, tempCsv);
                }

                // 3. cleanup
                try { Files.deleteIfExists(tempCsv); } catch (Exception ignore) {}

                OffsetDateTime tableEnd = OffsetDateTime.now();
                result.setStatus(StageTableStatus.success);
                result.setRowCount(rows);
                result.setFinishedAt(tableEnd);
                result.setDurationMs(Duration.between(tableStart, tableEnd).toMillis());
                stageTableResultRepo.save(result);

                ingest(ctx, "Loaded " + tobeTable + ": " + rows + " rows", true);
                successCount++;
            } catch (Exception e) {
                OffsetDateTime tableEnd = OffsetDateTime.now();
                result.setStatus(StageTableStatus.failed);
                Map<String, Object> detail = new HashMap<>();
                detail.put("message", e.getMessage());
                result.setErrorDetail(detail);
                result.setFinishedAt(tableEnd);
                result.setDurationMs(Duration.between(tableStart, tableEnd).toMillis());
                stageTableResultRepo.save(result);

                log.warn("LoadStage failed for {}: {}", tobeTable, e.getMessage());
                ingest(ctx, "Load failed for " + tobeTable + ": " + e.getMessage(), false);
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
            stage.setErrorSummary(failedCount + " tables failed in load stage");
        }
        stageInstanceRepo.save(stage);

        ingest(ctx, "Stage load completed — " + successCount + " success, " + failedCount + " failed", true);
        log.info("LoadStage success={} failed={}", successCount, failedCount);
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

    /** PostgreSQL 의 qualified table 명. schema 가 비면 unquoted (default search_path). */
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

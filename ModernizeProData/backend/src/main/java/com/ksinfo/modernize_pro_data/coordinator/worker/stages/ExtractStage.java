package com.ksinfo.modernize_pro_data.coordinator.worker.stages;

import com.ksinfo.modernize_pro_data.common.duckdb.DuckDbService;
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

import java.nio.file.Path;
import java.nio.file.Paths;
import java.sql.ResultSet;
import java.sql.Statement;
import java.time.Duration;
import java.time.OffsetDateTime;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Extract stage — AS-IS CSV → DuckDB load + parquet1 dump.
 *
 * 흐름:
 *   1. CREATE SCHEMA IF NOT EXISTS "{ctx.duckdbSchema}"
 *   2. 각 binding 별:
 *      - CSV path resolve (사용자 site.csv_path + tobe_table.csv)
 *      - CREATE OR REPLACE TABLE schema.asis_{tobe_table} AS SELECT * FROM read_csv_auto(...)
 *      - row_count = SELECT COUNT(*)
 *      - parquet1 dump = COPY ... TO 'parquet1/{tobe_table}.parquet' (FORMAT PARQUET)
 *
 * continue-on-error: binding 별 try/catch, 하나 실패해도 다음 진행.
 */
@Service
@RequiredArgsConstructor
@Slf4j
public class ExtractStage implements StageRunner {

    private static final String STAGE_KEY = "extract";

    private final StageInstanceRepository stageInstanceRepo;
    private final StageTableResultRepository stageTableResultRepo;
    private final DuckDbService duckDbService;
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

        String runId = ctx.getRunHistory().getId();
        String schema = ctx.getDuckdbSchema();
        Site site = ctx.getSite();
        List<MappingTableBinding> bindings = ctx.getBindings();

        ingest(ctx, "Stage extract started — " + bindings.size() + " bindings", true);

        // 1. DuckDB schema 준비
        try (Statement st = duckDbService.statement()) {
            st.execute("CREATE SCHEMA IF NOT EXISTS " + quoteIdent(schema));
        } catch (Exception e) {
            log.error("DuckDB schema create failed schema={}", schema, e);
            ingest(ctx, "Failed to create DuckDB schema " + schema + ": " + e.getMessage(), false);
            failStage(stage, startedAt, 0, bindings.size(), "schema create failed");
            return;
        }

        int successCount = 0;
        int failedCount = 0;

        for (MappingTableBinding binding : bindings) {
            OffsetDateTime tableStart = OffsetDateTime.now();
            String tobeSchema = binding.getTobeSchema() == null ? "" : binding.getTobeSchema();
            String tobeTable  = binding.getTobeTable();

            StageTableResult result = stageTableResultRepo
                    .findByStageInstanceIdAndBindingId(stage.getId(), binding.getId())
                    .orElseGet(() -> StageTableResult.create(stage.getId(), binding.getId(), tobeSchema, tobeTable));
            result.setStartedAt(tableStart);

            try {
                Path baseDir = Paths.get(site.getCsvPath()).toAbsolutePath().normalize();
                Path csv = StageHelpers.resolveCsvFile(baseDir, tobeTable);
                if (csv == null) {
                    throw new IllegalStateException("CSV not found: " + tobeTable + ".csv");
                }
                String escapedPath = csv.toString().replace("'", "''");
                String tableName = "asis_" + tobeTable;
                String fqTable = quoteIdent(schema) + "." + quoteIdent(tableName);

                long rowCount;
                try (Statement st = duckDbService.statement()) {
                    st.execute("CREATE OR REPLACE TABLE " + fqTable
                            + " AS SELECT * FROM read_csv_auto('" + escapedPath
                            + "', header=true, sample_size=-1, all_varchar=true)");

                    try (ResultSet rs = st.executeQuery("SELECT COUNT(*) FROM " + fqTable)) {
                        rs.next();
                        rowCount = rs.getLong(1);
                    }

                    Path parquet = ctx.parquet1Dir().resolve(tobeTable + ".parquet");
                    String escapedParquet = parquet.toString().replace("\\", "/").replace("'", "''");
                    st.execute("COPY " + fqTable + " TO '" + escapedParquet + "' (FORMAT PARQUET)");
                }

                OffsetDateTime tableEnd = OffsetDateTime.now();
                result.setStatus(StageTableStatus.success);
                result.setRowCount(rowCount);
                result.setFinishedAt(tableEnd);
                result.setDurationMs(Duration.between(tableStart, tableEnd).toMillis());
                stageTableResultRepo.save(result);

                ingest(ctx, "Extracted " + tobeTable + ": " + rowCount + " rows", true);
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

                log.warn("ExtractStage failed for binding {} ({}): {}", binding.getId(), tobeTable, e.getMessage());
                ingest(ctx, "Extract failed for " + tobeTable + ": " + e.getMessage(), false);
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
            stage.setErrorSummary(failedCount + " tables failed in extract stage");
        }
        stageInstanceRepo.save(stage);

        ingest(ctx, "Stage extract completed — " + successCount + " success, " + failedCount + " failed", true);
        log.info("ExtractStage runId={} success={} failed={}", runId, successCount, failedCount);
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

    private void ingest(StageContext ctx, String message, boolean info) {
        long seq = ctx.nextLogSeq();
        var line = info
                ? StageHelpers.info(seq, ctx.getRunHistory().getId(), STAGE_KEY, message)
                : StageHelpers.error(seq, ctx.getRunHistory().getId(), STAGE_KEY, message);
        runLogIngest.ingest(ctx.getRunHistory().getId(), ctx.getProject().getId(), List.of(line));
    }

    /** DuckDB identifier (schema / table) double-quote escape. */
    private static String quoteIdent(String name) {
        return "\"" + name.replace("\"", "\"\"") + "\"";
    }
}

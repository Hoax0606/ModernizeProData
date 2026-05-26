package com.ksinfo.modernize_pro_data.coordinator.worker.stages;

import com.ksinfo.modernize_pro_data.common.duckdb.DuckDbService;
import com.ksinfo.modernize_pro_data.coordinator.ddl.DdlColumn;
import com.ksinfo.modernize_pro_data.coordinator.ddl.DdlColumnRepository;
import com.ksinfo.modernize_pro_data.coordinator.ddl.DdlTable;
import com.ksinfo.modernize_pro_data.coordinator.ddl.DdlTableRepository;
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
import com.ksinfo.modernize_pro_data.coordinator.worker.StageContext;
import com.ksinfo.modernize_pro_data.coordinator.worker.StageHelpers;
import com.ksinfo.modernize_pro_data.coordinator.worker.StageRunner;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

import java.sql.ResultSet;
import java.sql.ResultSetMetaData;
import java.sql.Statement;
import java.time.Duration;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Audit stage — TO-BE DDL 의 제약 평가 (PoC: NOT NULL 만).
 *
 * 각 binding 별:
 *   - TO-BE DDL columns 중 nullable=false 컬럼 찾기
 *   - SELECT COUNT(*) FROM tobe_{table} WHERE col IS NULL
 *   - count > 0 → Quarantine 기록 (severity=error, sample 5 row)
 *
 * 추후: length / type / range 검사. PoC 1차는 NOT NULL 만.
 */
@Service
@RequiredArgsConstructor
@Slf4j
public class AuditStage implements StageRunner {

    private static final String STAGE_KEY = "audit";
    private static final int SAMPLE_LIMIT = 5;

    private final StageInstanceRepository stageInstanceRepo;
    private final StageTableResultRepository stageTableResultRepo;
    private final DdlTableRepository ddlTableRepo;
    private final DdlColumnRepository ddlColumnRepo;
    private final DuckDbService duckDbService;
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

        String projectId = ctx.getProject().getId();
        String schema = ctx.getDuckdbSchema();

        ingest(ctx, "Stage audit started — " + ctx.getBindings().size() + " bindings", true);

        // TO-BE DDL columns map: physical_name(table) → List<DdlColumn>
        Map<String, List<DdlColumn>> columnsByTable = new HashMap<>();
        List<DdlTable> tobeTables = ddlTableRepo.findByProjectIdAndSideOrderByOrdinalAsc(projectId, "tobe");
        for (DdlTable t : tobeTables) {
            columnsByTable.put(t.getPhysicalName(),
                    ddlColumnRepo.findByTableIdOrderByOrdinalAsc(t.getId()));
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
                List<DdlColumn> cols = columnsByTable.get(tobeTable);
                if (cols == null) {
                    throw new IllegalStateException("TO-BE DDL not found for " + tobeTable);
                }
                String fqTobe = quoteIdent(schema) + "." + quoteIdent("tobe_" + tobeTable);
                String pkCol = cols.stream()
                        .filter(c -> c.getPkOrder() != null)
                        .findFirst()
                        .map(DdlColumn::getPhysicalName)
                        .orElse(cols.isEmpty() ? null : cols.get(0).getPhysicalName());

                int violations = 0;
                for (DdlColumn col : cols) {
                    if (col.isNullable()) continue;
                    String colName = col.getPhysicalName();
                    long nullCount = countNulls(fqTobe, colName);
                    if (nullCount > 0) {
                        List<List<Object>> samples = fetchNullSamples(fqTobe, pkCol, colName);
                        Map<String, Object> sampleData = buildSampleData(
                                tobeTable, colName, pkCol, samples);
                        quarantineService.record(
                                ctx.getRunHistory().getId(),
                                stage.getId(),
                                binding.getId(),
                                null,
                                "NOT NULL violation — " + colName,
                                QuarantineSeverity.error,
                                sampleData,
                                nullCount,
                                ctx.getLogLineSeqCursor());
                        ingest(ctx, "Audit NOT NULL violation in " + tobeTable + "." + colName
                                + " (" + nullCount + " rows)", false);
                        violations++;
                    }
                }

                OffsetDateTime tableEnd = OffsetDateTime.now();
                if (violations > 0) {
                    result.setStatus(StageTableStatus.failed);
                    Map<String, Object> detail = new HashMap<>();
                    detail.put("message", violations + " NOT NULL violations");
                    result.setErrorDetail(detail);
                    failedCount++;
                } else {
                    result.setStatus(StageTableStatus.success);
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

                ingest(ctx, "Audit failed for " + tobeTable + ": " + e.getMessage(), false);
                failedCount++;
            }
        }

        OffsetDateTime finishedAt = OffsetDateTime.now();
        stage.setFinishedAt(finishedAt);
        stage.setDurationMs(Duration.between(startedAt, finishedAt).toMillis());
        stage.setTablesSuccess(successCount);
        stage.setTablesFailed(failedCount);
        stage.setStatus(failedCount == 0 ? StageStatus.success : StageStatus.failed);
        stageInstanceRepo.save(stage);

        ingest(ctx, "Stage audit completed — " + successCount + " success, " + failedCount + " failed", true);
        log.info("AuditStage success={} failed={}", successCount, failedCount);
    }

    private long countNulls(String fqTable, String colName) throws Exception {
        try (Statement st = duckDbService.statement();
             ResultSet rs = st.executeQuery("SELECT COUNT(*) FROM " + fqTable
                     + " WHERE " + quoteIdent(colName) + " IS NULL")) {
            rs.next();
            return rs.getLong(1);
        }
    }

    private List<List<Object>> fetchNullSamples(String fqTable, String pkCol, String violatedCol) throws Exception {
        List<List<Object>> samples = new ArrayList<>();
        StringBuilder cols = new StringBuilder();
        if (pkCol != null) cols.append(quoteIdent(pkCol)).append(", ");
        cols.append(quoteIdent(violatedCol));
        String sql = "SELECT " + cols + " FROM " + fqTable
                + " WHERE " + quoteIdent(violatedCol) + " IS NULL LIMIT " + SAMPLE_LIMIT;
        try (Statement st = duckDbService.statement();
             ResultSet rs = st.executeQuery(sql)) {
            ResultSetMetaData md = rs.getMetaData();
            int colCount = md.getColumnCount();
            while (rs.next()) {
                List<Object> row = new ArrayList<>(colCount);
                for (int i = 1; i <= colCount; i++) row.add(rs.getObject(i));
                samples.add(row);
            }
        }
        return samples;
    }

    private Map<String, Object> buildSampleData(String tobeTable, String violatedCol,
                                                String pkCol, List<List<Object>> samples) {
        Map<String, Object> data = new HashMap<>();
        data.put("reason", "NOT NULL violation");
        data.put("detail", tobeTable + "." + violatedCol + " is NULL");
        data.put("severity", "error");
        data.put("stageLabel", "validate.notnull");
        data.put("table", tobeTable);
        List<String> columns = new ArrayList<>();
        List<String> roles = new ArrayList<>();
        if (pkCol != null) { columns.add(pkCol); roles.add("pk"); }
        columns.add(violatedCol);
        roles.add("violated");
        data.put("columns", columns);
        data.put("columnRoles", roles);
        data.put("sampleRows", samples);
        return data;
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

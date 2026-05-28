package com.ksinfo.modernize_pro_data.coordinator.worker.stages;

import com.ksinfo.modernize_pro_data.common.duckdb.DuckDbService;
import com.ksinfo.modernize_pro_data.coordinator.ddl.DdlColumn;
import com.ksinfo.modernize_pro_data.coordinator.ddl.DdlColumnRepository;
import com.ksinfo.modernize_pro_data.coordinator.ddl.DdlTable;
import com.ksinfo.modernize_pro_data.coordinator.ddl.DdlTableRepository;
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
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

/**
 * Verify stage — Load 정합성 검증 (DuckDB tobe_xxx vs PostgreSQL).
 *
 * 2 단계:
 *   1. row_count 비교 — DuckDB tobe_{table} (Transform 결과) vs PostgreSQL {tobe_table} (Load 결과).
 *      다르면 quarantine(verify.checksum) + fail, PK 비교 skip.
 *   2. row_count 가 같으면 PK 정렬 전수 비교 — 양쪽 전체 row 를 PK 로 정렬해 모든 PK 값을 대조.
 *      불일치 → quarantine(verify.rowmatch) + fail. (행 정체성·누락 검출)
 *
 * 값 정확성은 AuditStage 가 Load 전 전수로 책임지고, Verify 는 적재 정합성만 본다.
 * (Load 는 DuckDB 텍스트 → PG 단순 COPY 라 값 비교는 포맷 차이로 오탐만 늘림 → 제외.)
 */
@Service
@RequiredArgsConstructor
@Slf4j
public class VerifyStage implements StageRunner {

    private static final String STAGE_KEY = "verify";

    private final StageInstanceRepository stageInstanceRepo;
    private final StageTableResultRepository stageTableResultRepo;
    private final DdlTableRepository ddlTableRepo;
    private final DdlColumnRepository ddlColumnRepo;
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

        Map<String, Object> dbConfig = site.getActiveTobeDbConfig();
        if (dbConfig == null) {
            failStage(stage, startedAt, 0, ctx.getBindings().size(), "tobe DB config not set");
            ingest(ctx, "Verify failed — tobe DB config not set", false);
            return;
        }

        // TO-BE DDL columns map: physical_name(table) → List<DdlColumn> (PK 컬럼 조회용)
        String projectId = ctx.getProject().getId();
        Map<String, List<DdlColumn>> columnsByTable = new HashMap<>();
        for (DdlTable t : ddlTableRepo.findByProjectIdAndSideOrderByOrdinalAsc(projectId, "tobe")) {
            columnsByTable.put(t.getPhysicalName(), ddlColumnRepo.findByTableIdOrderByOrdinalAsc(t.getId()));
        }

        int successCount = 0;
        int failedCount = 0;

        for (MappingTableBinding binding : ctx.getBindings()) {
            OffsetDateTime tableStart = OffsetDateTime.now();
            String tobeSchema = binding.getTobeSchema() == null ? "" : binding.getTobeSchema();
            String tobeTable  = binding.getTobeTable();
            /* Quarantine / 사용자 표시용 — schema 있으면 'schema.table'. SQL 식별자 아님. */
            String tableLabel = tobeSchema.isBlank() ? tobeTable : tobeSchema + "." + tobeTable;

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
                    sampleData.put("detail", tableLabel + ": DuckDB=" + duckCount + " vs PostgreSQL=" + pgCount);
                    sampleData.put("severity", "error");
                    sampleData.put("stageLabel", "verify.checksum");
                    sampleData.put("table", tableLabel);
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
                            "Row count mismatch — " + tableLabel,
                            QuarantineSeverity.error,
                            sampleData,
                            Math.abs(duckCount - pgCount),
                            ctx.getLogLineSeqCursor());
                    result.setStatus(StageTableStatus.failed);
                    Map<String, Object> detail = new HashMap<>();
                    detail.put("message", "DuckDB=" + duckCount + " ≠ PG=" + pgCount);
                    result.setErrorDetail(detail);
                    ingest(ctx, "Verify mismatch " + tableLabel + ": DuckDB=" + duckCount + " vs PG=" + pgCount, false);
                    failedCount++;
                } else {
                    // row count 일치 → PK 정렬 전수 비교 (행 정체성·누락 검출)
                    List<String> pkCols = pkColumns(columnsByTable.get(tobeTable));
                    String pkMismatch = compareAllPkRows(fqDuck, pgQualified, pkCols, dbConfig);
                    if (pkMismatch != null) {
                        Map<String, Object> sampleData = new HashMap<>();
                        sampleData.put("reason", "PK row mismatch");
                        sampleData.put("detail", tableLabel + ": " + pkMismatch);
                        sampleData.put("severity", "error");
                        sampleData.put("stageLabel", "verify.rowmatch");
                        sampleData.put("table", tableLabel);
                        sampleData.put("columns", List.of("pk", "detail"));
                        sampleData.put("columnRoles", List.of("pk", "violated"));
                        sampleData.put("sampleRows", List.of(List.of(String.join(",", pkCols), pkMismatch)));
                        quarantineService.record(
                                ctx.getRunHistory().getId(),
                                stage.getId(),
                                binding.getId(),
                                null,
                                "PK row mismatch — " + tableLabel,
                                QuarantineSeverity.error,
                                sampleData,
                                1,
                                ctx.getLogLineSeqCursor());
                        result.setStatus(StageTableStatus.failed);
                        Map<String, Object> detail = new HashMap<>();
                        detail.put("message", pkMismatch);
                        result.setErrorDetail(detail);
                        ingest(ctx, "Verify PK mismatch " + tableLabel + ": " + pkMismatch, false);
                        failedCount++;
                    } else {
                        result.setStatus(StageTableStatus.success);
                        result.setRowCount(pgCount);
                        ingest(ctx, "Verified " + tableLabel + ": " + pgCount + " rows (all PK rows OK)", true);
                        successCount++;
                    }
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

    /** PK 컬럼 physical_name 목록 (pk_order 순). PK 없으면 첫 컬럼 fallback, 컬럼도 없으면 빈 list. */
    private List<String> pkColumns(List<DdlColumn> cols) {
        List<String> pks = new ArrayList<>();
        if (cols == null || cols.isEmpty()) return pks;
        cols.stream()
                .filter(c -> c.getPkOrder() != null)
                .sorted(Comparator.comparing(DdlColumn::getPkOrder))
                .forEach(c -> pks.add(c.getPhysicalName()));
        if (pks.isEmpty()) pks.add(cols.get(0).getPhysicalName());
        return pks;
    }

    /**
     * 양쪽 전체 row 를 PK 정렬해 모든 PK 값을 전수 비교. 일치=null, 불일치=사유 메시지. PK 없으면 skip(null).
     *
     * 대용량 대비 — 양쪽 ResultSet 을 PK 순서로 동시에 streaming 하며 row 단위 lockstep 비교한다.
     * (전체 키를 메모리에 materialize 하지 않음. 첫 불일치에서 즉시 멈춘다.)
     * row_count 는 호출 전에 이미 같음을 확인했지만, 한쪽이 먼저 소진되면 안전망으로 보고한다.
     *
     * (가시성 package-private — VerifyStageFullCompareTest 가 전수 비교 동작을 직접 검증.)
     */
    String compareAllPkRows(String fqDuck, String pgQualified,
                            List<String> pkCols, Map<String, Object> dbConfig) throws Exception {
        if (pkCols.isEmpty()) return null;
        String selCols = pkCols.stream().map(VerifyStage::quoteIdent).collect(Collectors.joining(", "));
        String duckSql = "SELECT " + selCols + " FROM " + fqDuck + " ORDER BY " + selCols;
        String pgSql   = "SELECT " + selCols + " FROM " + pgQualified + " ORDER BY " + selCols;

        int colCount = pkCols.size();
        long row = 0;
        try (Statement duckSt = duckDbService.statement();
             ResultSet duckRs = duckSt.executeQuery(duckSql);
             Connection conn = pgCopyManager.openConnection(dbConfig);
             Statement pgSt = conn.createStatement();
             ResultSet pgRs = pgSt.executeQuery(pgSql)) {
            while (true) {
                boolean duckHas = duckRs.next();
                boolean pgHas = pgRs.next();
                if (!duckHas && !pgHas) break;   // 둘 다 끝 → 전수 일치
                row++;
                if (duckHas != pgHas) {
                    return "PK row count mismatch near row " + row + ": "
                            + (duckHas ? "DuckDB has more rows" : "DuckDB exhausted")
                            + " / " + (pgHas ? "PG has more rows" : "PG exhausted");
                }
                String duckKey = readKey(duckRs, colCount);
                String pgKey = readKey(pgRs, colCount);
                if (!duckKey.equals(pgKey)) {
                    return "PK mismatch at row " + row + ": DuckDB=" + duckKey + " vs PG=" + pgKey;
                }
            }
        }
        return null;
    }

    /** 현재 ResultSet row 의 PK 컬럼들을 '|' 로 이은 텍스트 키로. NULL 은 \\N. */
    private static String readKey(ResultSet rs, int colCount) throws Exception {
        StringBuilder sb = new StringBuilder();
        for (int i = 1; i <= colCount; i++) {
            if (i > 1) sb.append("|");
            Object v = rs.getObject(i);
            sb.append(v == null ? "\\N" : v.toString());
        }
        return sb.toString();
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

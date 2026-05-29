package com.ksinfo.modernize_pro_data.coordinator.worker.stages;

import com.ksinfo.modernize_pro_data.common.duckdb.DuckDbService;
import com.ksinfo.modernize_pro_data.coordinator.ddl.DdlColumn;
import com.ksinfo.modernize_pro_data.coordinator.ddl.DdlColumnRepository;
import com.ksinfo.modernize_pro_data.coordinator.ddl.DdlTable;
import com.ksinfo.modernize_pro_data.coordinator.ddl.DdlTableRepository;
import com.ksinfo.modernize_pro_data.coordinator.load.PgCopyManager;
import com.ksinfo.modernize_pro_data.coordinator.load.PgDdlGenerator;
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
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.ResultSet;
import java.sql.ResultSetMetaData;
import java.sql.Statement;
import java.time.Duration;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.stream.Collectors;

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

    /** Load 병렬도. 1 = 순차(기본). >1 이면 테이블(binding) 단위로 동시 적재. */
    @Value("${modernize.run.load-parallelism:1}")
    private int loadParallelism;

    private final StageInstanceRepository stageInstanceRepo;
    private final StageTableResultRepository stageTableResultRepo;
    private final DdlTableRepository ddlTableRepo;
    private final DdlColumnRepository ddlColumnRepo;
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

        Map<String, Object> dbConfig = site.getActiveTobeDbConfig();
        if (dbConfig == null) {
            failStage(stage, startedAt, 0, ctx.getBindings().size(), "tobe DB config not set");
            ingest(ctx, "Load failed — tobe DB config not set", false);
            return;
        }

        // PoC1 부트스트랩 — TO-BE DDL 의 컬럼 메타 미리 적재. ensurePgTable 가 사용.
        // (별도 migration tooling 도입 전까지 LoadStage 가 schema/table 도 자동 생성.)
        String projectId = ctx.getProject().getId();
        Map<String, List<DdlColumn>> columnsByTable = new HashMap<>();
        for (DdlTable t : ddlTableRepo.findByProjectIdAndSideOrderByOrdinalAsc(projectId, "tobe")) {
            columnsByTable.put(t.getPhysicalName(),
                    ddlColumnRepo.findByTableIdOrderByOrdinalAsc(t.getId()));
        }

        Path tempDir = ctx.getOutputDir().resolve("temp");
        try {
            Files.createDirectories(tempDir);
        } catch (Exception e) {
            failStage(stage, startedAt, 0, ctx.getBindings().size(), "temp dir create failed: " + e.getMessage());
            return;
        }

        List<MappingTableBinding> bindings = ctx.getBindings();
        AtomicInteger success = new AtomicInteger();
        AtomicInteger failed = new AtomicInteger();
        int parallelism = Math.max(1, loadParallelism);

        if (parallelism <= 1 || bindings.size() <= 1) {
            // 순차 (기본)
            for (MappingTableBinding b : bindings) {
                if (loadBinding(ctx, stage, b, dbConfig, tempDir, columnsByTable)) success.incrementAndGet();
                else failed.incrementAndGet();
            }
        } else {
            // 테이블(binding) 단위 병렬 적재. 각 task 가 자기 DuckDB/PG connection 사용.
            int poolSize = Math.min(parallelism, bindings.size());
            ingest(ctx, "Load parallel — " + poolSize + " threads", true);
            ExecutorService pool = Executors.newFixedThreadPool(poolSize);
            try {
                List<Future<?>> futures = new ArrayList<>();
                for (MappingTableBinding b : bindings) {
                    futures.add(pool.submit(() -> {
                        if (loadBinding(ctx, stage, b, dbConfig, tempDir, columnsByTable)) success.incrementAndGet();
                        else failed.incrementAndGet();
                    }));
                }
                for (Future<?> f : futures) {
                    try { f.get(); } catch (Exception e) { log.warn("Load task error: {}", e.getMessage()); }
                }
            } finally {
                pool.shutdown();
            }
        }

        int successCount = success.get();
        int failedCount = failed.get();

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

    /**
     * 한 binding 적재. 성공=true / 실패·skip=false. 병렬 task 로도 호출되므로 task-local 자원만 사용:
     * DuckDB 는 duplicateConnection(공유 connection 동시 사용 회피), PG 는 per-binding openConnection.
     */
    private boolean loadBinding(StageContext ctx, StageInstance stage, MappingTableBinding binding,
                                Map<String, Object> dbConfig, Path tempDir,
                                Map<String, List<DdlColumn>> columnsByTable) {
        String schema = ctx.getDuckdbSchema();
        OffsetDateTime tableStart = OffsetDateTime.now();
        String tobeSchema = binding.getTobeSchema() == null ? "" : binding.getTobeSchema();
        String tobeTable  = binding.getTobeTable();

        StageTableResult result = stageTableResultRepo
                .findByStageInstanceIdAndBindingId(stage.getId(), binding.getId())
                .orElseGet(() -> StageTableResult.create(stage.getId(), binding.getId(), tobeSchema, tobeTable));
        result.setStartedAt(tableStart);

        Path tempCsv = tempDir.resolve(tobeTable + ".csv");
        try {
            // 검증/이전 단계가 이 테이블을 실패로 표시했으면 적재 skip (bad data → Postgres 방지).
            if (upstreamFailed(ctx, stage, binding.getId())) {
                result.setStatus(StageTableStatus.failed);
                Map<String, Object> detail = new HashMap<>();
                detail.put("message", "not loaded — upstream stage failed for this table");
                result.setErrorDetail(detail);
                finish(result, tableStart);
                stageTableResultRepo.save(result);
                ingest(ctx, "Load skipped " + tobeTable + " — upstream stage failed (not loaded)", false);
                return false;
            }

            // 1. DuckDB → temp CSV (task 별 connection — 병렬 안전).
            //    tobe_ 의 컬럼명을 순서대로 수집 → CSV 필드 순서와 동일 → PG COPY 명시 컬럼 리스트로 전달해
            //    transform SELECT 순서(mapping_rules 순)와 PG DDL ordinal 의 어긋남으로 인한 silent 컬럼
            //    misalignment 방지.
            String fqTobeDuck = quoteIdent(schema) + "." + quoteIdent("tobe_" + tobeTable);
            String escapedCsv = tempCsv.toString().replace("\\", "/").replace("'", "''");
            List<String> tobeColumns = new ArrayList<>();
            try (Connection duck = duckDbService.duplicateConnection();
                 Statement st = duck.createStatement()) {
                try (ResultSet rs = st.executeQuery("SELECT * FROM " + fqTobeDuck + " LIMIT 0")) {
                    ResultSetMetaData md = rs.getMetaData();
                    for (int i = 1; i <= md.getColumnCount(); i++) {
                        tobeColumns.add(md.getColumnLabel(i));
                    }
                }
                st.execute("COPY " + fqTobeDuck + " TO '" + escapedCsv + "' (FORMAT CSV, HEADER false)");
            }

            // Artifact 표시용 통합 SQL: Transform 의 SELECT 를 COPY 의 source 로 감싼 형태로
            // stage_table_results.compiled_sql 에 박제. 실제 실행은 위 2-step (DuckDB COPY OUT
            // + 아래 PG COPY IN). ArtifactsPage MIGRATION SQL 카테고리가 이 텍스트를 그대로 표시.
            String transformSql = ctx.getStages().stream()
                    .filter(s -> "transform".equals(s.getStageKey()))
                    .findFirst()
                    .flatMap(s -> stageTableResultRepo.findByStageInstanceIdAndBindingId(s.getId(), binding.getId()))
                    .map(StageTableResult::getCompiledSql)
                    .orElse(null);
            if (transformSql != null) {
                result.setCompiledSql(buildLoadArtifactSql(tobeSchema, tobeTable, tobeColumns, transformSql));
            }

            // 2. PostgreSQL Connection + (PoC1 부트스트랩) + (FK off) + TRUNCATE + COPY + (FK 복귀)
            String pgQualified = pgTableName(tobeSchema, tobeTable);
            long rows;
            try (Connection conn = pgCopyManager.openConnection(dbConfig)) {
                ensurePgTable(ctx, conn, tobeSchema, tobeTable, columnsByTable);
                boolean fkDisabled = pgCopyManager.tryDisableConstraints(conn);
                try {
                    pgCopyManager.truncate(conn, pgQualified);
                    rows = pgCopyManager.copyInFromCsv(conn, pgQualified, tempCsv, tobeColumns);
                } finally {
                    if (fkDisabled) pgCopyManager.restoreConstraints(conn);
                }
            }

            try { Files.deleteIfExists(tempCsv); } catch (Exception ignore) {}

            result.setStatus(StageTableStatus.success);
            result.setRowCount(rows);
            finish(result, tableStart);
            stageTableResultRepo.save(result);
            ingest(ctx, "Loaded " + tobeTable + ": " + rows + " rows", true);
            return true;
        } catch (Exception e) {
            result.setStatus(StageTableStatus.failed);
            Map<String, Object> detail = new HashMap<>();
            detail.put("message", e.getMessage());
            result.setErrorDetail(detail);
            finish(result, tableStart);
            stageTableResultRepo.save(result);
            log.warn("LoadStage failed for {}: {}", tobeTable, e.getMessage());
            ingest(ctx, "Load failed for " + tobeTable + ": " + e.getMessage(), false);
            return false;
        }
    }

    private static void finish(StageTableResult result, OffsetDateTime start) {
        OffsetDateTime end = OffsetDateTime.now();
        result.setFinishedAt(end);
        result.setDurationMs(Duration.between(start, end).toMillis());
    }

    /**
     * 이 binding 이 load 이전 단계(check/extract/reconcile/transform/audit)에서 failed 로 표시됐는지.
     * 하나라도 failed 면 적재하지 않는다 (검증 실패 테이블이 TO-BE DB 로 가는 것 방지).
     */
    private boolean upstreamFailed(StageContext ctx, StageInstance loadStage, String bindingId) {
        int loadSeq = loadStage.getSeq() == null ? -1 : loadStage.getSeq().intValue();
        if (loadSeq < 0) return false;
        for (StageInstance s : ctx.getStages()) {
            if (s.getSeq() == null || s.getSeq().intValue() >= loadSeq) continue;
            boolean failed = stageTableResultRepo
                    .findByStageInstanceIdAndBindingId(s.getId(), bindingId)
                    .map(r -> r.getStatus() == StageTableStatus.failed)
                    .orElse(false);
            if (failed) return true;
        }
        return false;
    }

    /**
     * PoC1 부트스트랩 — target PG 에 TO-BE schema/table 이 없으면 자동 생성.
     * {@code IF NOT EXISTS} 라 DBA 가 미리 Migration SQL 적용해두면 NO-OP.
     * 컬럼 메타가 없으면 (DDL 미등록) skip — 기존 동작(테이블 부재 → COPY 실패) 그대로.
     */
    private void ensurePgTable(StageContext ctx, Connection conn, String tobeSchema, String tobeTable,
                               Map<String, List<DdlColumn>> columnsByTable) throws Exception {
        List<DdlColumn> cols = columnsByTable.get(tobeTable);
        if (cols == null || cols.isEmpty()) return;
        try (Statement st = conn.createStatement()) {
            if (tobeSchema != null && !tobeSchema.isBlank()) {
                st.executeUpdate(PgDdlGenerator.createSchemaIfNotExists(tobeSchema));
            }
            st.executeUpdate(PgDdlGenerator.createTableIfNotExists(tobeSchema, tobeTable, cols));
        }
        ingest(ctx, "Ensured PG table " + (tobeSchema == null || tobeSchema.isBlank() ? "" : tobeSchema + ".") + tobeTable, true);
    }

    /** PostgreSQL 의 qualified table 명. schema 가 비면 unquoted (default search_path). */
    /**
     * Artifact 표시용 통합 SQL.
     * Transform 의 박제된 CREATE OR REPLACE TABLE ... AS SELECT ... 에서 SELECT 절을 떼어내고,
     * 그걸 COPY ... FROM ( ... ) 의 source 로 감싼다. PG 의 실제 COPY syntax 는 아니지만
     * (PG COPY 는 file/stdin 만), 사용자가 "이 테이블이 어떤 SELECT 로 만들어져 어디로 적재됐는가"
     * 를 한 화면에서 보게 하기 위한 표시용 합성 SQL.
     */
    private static String buildLoadArtifactSql(String tobeSchema, String tobeTable,
                                               List<String> tobeColumns, String transformSql) {
        // Transform SQL 형식: "CREATE OR REPLACE TABLE ... AS\nSELECT\n  ...\nFROM ...\n[WHERE ...]"
        // SELECT 시작부터 끝까지를 잘라낸다.
        int selectIdx = transformSql.indexOf("\nSELECT\n");
        String selectPart = selectIdx >= 0 ? transformSql.substring(selectIdx + 1) : transformSql;
        // SELECT 부분에 2-space 들여쓰기를 추가해 wrap 안에서 보기 좋게.
        String indented = selectPart.lines().map(l -> "  " + l).collect(Collectors.joining("\n"));

        String fqTobe = (tobeSchema == null || tobeSchema.isBlank() ? "" : quoteIdent(tobeSchema) + ".")
                + quoteIdent(tobeTable);
        StringBuilder colsLine = new StringBuilder();
        for (int i = 0; i < tobeColumns.size(); i++) {
            if (i > 0) colsLine.append(", ");
            colsLine.append(quoteIdent(tobeColumns.get(i)));
        }

        return "COPY " + fqTobe + " (\n"
                + "  " + colsLine + "\n"
                + ") FROM (\n"
                + indented + "\n"
                + ");";
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

package com.ksinfo.modernize_pro_data.coordinator.worker.stages;

import com.ksinfo.modernize_pro_data.common.duckdb.DuckDbService;
import com.ksinfo.modernize_pro_data.coordinator.ddl.DdlColumn;
import com.ksinfo.modernize_pro_data.coordinator.ddl.DdlColumnRepository;
import com.ksinfo.modernize_pro_data.coordinator.ddl.DdlConstraint;
import com.ksinfo.modernize_pro_data.coordinator.ddl.DdlConstraintColumn;
import com.ksinfo.modernize_pro_data.coordinator.ddl.DdlConstraintColumnRepository;
import com.ksinfo.modernize_pro_data.coordinator.ddl.DdlConstraintRepository;
import com.ksinfo.modernize_pro_data.coordinator.ddl.DdlForeignKey;
import com.ksinfo.modernize_pro_data.coordinator.ddl.DdlForeignKeyRepository;
import com.ksinfo.modernize_pro_data.coordinator.ddl.DdlTable;
import com.ksinfo.modernize_pro_data.coordinator.ddl.DdlTableRepository;
import com.ksinfo.modernize_pro_data.coordinator.load.PgCopyManager;
import com.ksinfo.modernize_pro_data.coordinator.load.PgDdlGenerator;
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
import com.ksinfo.modernize_pro_data.coordinator.worker.StageProgressBroadcaster;
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
    /** FK orphan / CHECK 위반 WARN quarantine 의 sample row 상한 (AuditStage 와 동일). */
    private static final int CONSTRAINT_SAMPLE_LIMIT = 1000;

    /** Load 병렬도. 1 = 순차(기본). >1 이면 테이블(binding) 단위로 동시 적재. */
    @Value("${modernize.run.load-parallelism:1}")
    private int loadParallelism;

    private final StageInstanceRepository stageInstanceRepo;
    private final StageTableResultRepository stageTableResultRepo;
    private final DdlTableRepository ddlTableRepo;
    private final DdlColumnRepository ddlColumnRepo;
    private final DdlConstraintRepository ddlConstraintRepo;
    private final DdlConstraintColumnRepository ddlConstraintColumnRepo;
    private final DdlForeignKeyRepository ddlForeignKeyRepo;
    private final DuckDbService duckDbService;
    private final PgCopyManager pgCopyManager;
    private final QuarantineService quarantineService;
    private final RunLogIngestService runLogIngest;
    private final StageProgressBroadcaster broadcaster;
    private final com.ksinfo.modernize_pro_data.coordinator.run.RunControlRegistry runControlRegistry;

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
        List<DdlTable> tobeTables = ddlTableRepo.findByProjectIdAndSideOrderByOrdinalAsc(projectId, "tobe");
        Map<String, List<DdlColumn>> columnsByTable = new HashMap<>();
        for (DdlTable t : tobeTables) {
            columnsByTable.put(t.getPhysicalName(),
                    ddlColumnRepo.findByTableIdOrderByOrdinalAsc(t.getId()));
        }
        // UK / FK / CHECK 메타 사전 로딩 (적재 후 부착에 사용)
        Map<String, List<UniqueConstraintMeta>> uniqueByTable = new HashMap<>();
        Map<String, List<ForeignKeyMeta>> fksByTable = new HashMap<>();
        Map<String, List<CheckConstraintMeta>> checksByTable = new HashMap<>();
        loadConstraintMetas(tobeTables, uniqueByTable, fksByTable, checksByTable);

        // (옛 CSV-파일 경유 COPY 시절의 staging 디렉터리였으나, 현재는 DuckDB ResultSet →
        //  PGCopyOutputStream 직스트림이라 temp 폴더가 더 이상 필요 없다. 생성 제거 #73.)
        List<MappingTableBinding> bindings = ctx.getBindings();
        AtomicInteger success = new AtomicInteger();
        AtomicInteger failed = new AtomicInteger();
        int parallelism = Math.max(1, loadParallelism);

        String runId = ctx.getRunHistory().getId();
        if (parallelism <= 1 || bindings.size() <= 1) {
            // 순차 (기본)
            for (MappingTableBinding b : bindings) {
                // Stop 반응 — 남은 테이블 적재 시작 전 cancel 확인 (다중 테이블 빠른 중단).
                if (runControlRegistry.isCancelled(runId)) {
                    log.warn("Load cancelled — skipping remaining tables runId={}", runId);
                    break;
                }
                if (loadBinding(ctx, stage, b, dbConfig, columnsByTable, uniqueByTable, fksByTable, checksByTable)) success.incrementAndGet();
                else failed.incrementAndGet();
                stage.setTablesSuccess(success.get());
                stage.setTablesFailed(failed.get());
                stageInstanceRepo.save(stage);
                broadcaster.stageProgress(runId, stage);
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
                        // 병렬 task 도 시작 시 cancel 확인 — 이미 취소면 적재 skip.
                        if (runControlRegistry.isCancelled(runId)) { failed.incrementAndGet(); return; }
                        if (loadBinding(ctx, stage, b, dbConfig, columnsByTable, uniqueByTable, fksByTable, checksByTable)) success.incrementAndGet();
                        else failed.incrementAndGet();
                        // stage entity save 경합 회피용 동기화 — Load 끝 broadcast.
                        synchronized (stage) {
                            stage.setTablesSuccess(success.get());
                            stage.setTablesFailed(failed.get());
                            stageInstanceRepo.save(stage);
                            broadcaster.stageProgress(runId, stage);
                        }
                    }));
                }
                for (Future<?> f : futures) {
                    try { f.get(); } catch (Exception e) { log.warn("Load task error: {}", e.getMessage()); }
                }
            } finally {
                pool.shutdown();
            }
        }

        // ── FINAL PASS — FK / CHECK 부착 + 위반 감지 (모든 테이블 적재 후라 부모 present) ──
        // orphan(부모 없는 자식)·CHECK 위반은 삭제하지 않고 WARN quarantine 으로 표면화,
        // 깨끗하면 VALIDATE 로 제약 확정, 위반 있으면 NOT VALID 유지(운영자/비즈니스 판단).
        try {
            applyDeferredConstraints(ctx, stage, dbConfig, bindings, fksByTable, checksByTable);
        } catch (Exception e) {
            log.warn("applyDeferredConstraints failed runId={}: {}", runId, e.getMessage());
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
                                Map<String, Object> dbConfig,
                                Map<String, List<DdlColumn>> columnsByTable,
                                Map<String, List<UniqueConstraintMeta>> uniqueByTable,
                                Map<String, List<ForeignKeyMeta>> fksByTable,
                                Map<String, List<CheckConstraintMeta>> checksByTable) {
        String schema = ctx.getDuckdbSchema();
        OffsetDateTime tableStart = OffsetDateTime.now();
        String tobeSchema = binding.getTobeSchema() == null ? "" : binding.getTobeSchema();
        String tobeTable  = binding.getTobeTable();
        String tableLabel = tobeSchema.isBlank() ? tobeTable : tobeSchema + "." + tobeTable;

        StageTableResult result = stageTableResultRepo
                .findByStageInstanceIdAndBindingId(stage.getId(), binding.getId())
                .orElseGet(() -> StageTableResult.create(stage.getId(), binding.getId(), tobeSchema, tobeTable));
        result.setStartedAt(tableStart);

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

            /* 1. DuckDB tobe_ 테이블의 컬럼 순서 (PG COPY 의 명시 컬럼 리스트 와 ResultSet
                  순서가 1:1) — PG DDL ordinal 과 무관하게 정확히 들어가게 함. */
            String fqTobeDuck = quoteIdent(schema) + "." + quoteIdent("tobe_" + tobeTable);
            List<String> tobeColumns = new ArrayList<>();
            try (Connection duck = duckDbService.duplicateOf(ctx.getDuckConnection());
                 Statement metaSt = duck.createStatement();
                 ResultSet rs = metaSt.executeQuery("SELECT * FROM " + fqTobeDuck + " LIMIT 0")) {
                ResultSetMetaData md = rs.getMetaData();
                for (int i = 1; i <= md.getColumnCount(); i++) {
                    tobeColumns.add(md.getColumnLabel(i));
                }
            }

            // Artifact 표시용 통합 SQL: Transform 의 SELECT 를 COPY 의 source 로 감싼 형태로
            // stage_table_results.compiled_sql 에 박제. 실제 실행은 ResultSet stream → PG COPY.
            // ArtifactsPage MIGRATION SQL 카테고리가 이 텍스트를 그대로 표시.
            String transformSql = ctx.getStages().stream()
                    .filter(s -> "transform".equals(s.getStageKey()))
                    .findFirst()
                    .flatMap(s -> stageTableResultRepo.findByStageInstanceIdAndBindingId(s.getId(), binding.getId()))
                    .map(StageTableResult::getCompiledSql)
                    .orElse(null);
            if (transformSql != null) {
                result.setCompiledSql(buildLoadArtifactSql(tobeSchema, tobeTable, tobeColumns, transformSql));
            }

            /* 2. DuckDB SELECT * → PG COPY FROM STDIN streaming. 중간 CSV 파일 X.
                  PG connection 과 DuckDB connection 을 동시 열고, ResultSet 을 한 row 씩
                  CSV 직렬화 → PGCopyOutputStream. PgCopyManager.copyInFromResultSet 참고. */
            String pgQualified = pgTableName(tobeSchema, tobeTable);
            long rows;
            // cutover = production 전환 → synchronous_commit 절대 끄지 않음 (durability 우선).
            boolean cutover = ctx.getRunHistory().getRunType()
                    == com.ksinfo.modernize_pro_data.coordinator.run.RunType.cutover;
            try (Connection conn = pgCopyManager.openConnection(dbConfig, !cutover)) {
                ensurePgTable(ctx, conn, tobeSchema, tobeTable, columnsByTable);
                boolean fkDisabled = pgCopyManager.tryDisableConstraints(conn);
                try {
                    pgCopyManager.truncate(conn, pgQualified);
                    String runIdForCancel = ctx.getRunHistory().getId();
                    try (Connection duck = duckDbService.duplicateOf(ctx.getDuckConnection());
                         Statement duckSt = duck.createStatement();
                         ResultSet rs = duckSt.executeQuery("SELECT * FROM " + fqTobeDuck)) {
                        // cancel supplier — COPY 도중 Stop 누르면 행 루프가 중단 throw → conn close → COPY abort.
                        rows = pgCopyManager.copyInFromResultSet(conn, pgQualified, tobeColumns, rs,
                                () -> runControlRegistry.isCancelled(runIdForCancel));
                    }
                } finally {
                    if (fkDisabled) pgCopyManager.restoreConstraints(conn);
                }
                /* 적재 후 UK 부착 (테이블 단위, cross-table 의존 없음). PG PRIMARY KEY 는
                   createTableIfNotExists 에 inline — PG 가 <table>_pkey unique index 자동 생성.
                   FK / CHECK 는 모든 테이블 적재 후 final pass(applyDeferredConstraints)에서 부착·검증.
                   per-binding 이면 자식이 부모보다 먼저 적재돼 가짜 orphan 이 날 수 있어서. */
                ensureUniqueConstraints(ctx, conn, tobeSchema, tobeTable, uniqueByTable);
            }

            result.setStatus(StageTableStatus.success);
            result.setRowCount(rows);
            finish(result, tableStart);
            stageTableResultRepo.save(result);
            ingest(ctx, "Loaded " + tobeTable + ": " + rows + " rows", true);
            return true;
        } catch (java.util.concurrent.CancellationException ce) {
            // 사용자 Stop 으로 인한 중단 — 실패(quarantine)가 아니라 의도된 취소.
            result.setStatus(StageTableStatus.failed);
            Map<String, Object> detail = new HashMap<>();
            detail.put("message", "load aborted by user (Stop)");
            result.setErrorDetail(detail);
            finish(result, tableStart);
            stageTableResultRepo.save(result);
            log.warn("LoadStage aborted for {} — {}", tobeTable, ce.getMessage());
            ingest(ctx, "Load aborted for " + tableLabel + " (Stop)", false);
            return false;
        } catch (Exception e) {
            result.setStatus(StageTableStatus.failed);
            Map<String, Object> detail = new HashMap<>();
            detail.put("message", e.getMessage());
            result.setErrorDetail(detail);
            finish(result, tableStart);
            stageTableResultRepo.save(result);

            /* Step 1 — PG COPY 실패 (NOT NULL / FK / 타입 변환 등) 를 Quarantine 카드로. */
            StageHelpers.recordStageFailureQuarantine(ctx, quarantineService, stage, binding,
                    tableLabel, "Load", "load.failure", e.getMessage());

            log.warn("LoadStage failed for {}: {}", tobeTable, e.getMessage());
            ingest(ctx, "Load failed for " + tableLabel + ": " + e.getMessage(), false);
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

    /**
     * 적재 후 UK 부착. {@code ALTER TABLE ... ADD CONSTRAINT name UNIQUE (...)}.
     * 이미 존재 시 PG 에러 → catch 후 log 만 (멱등). 실패는 적재 자체엔 영향 없음.
     */
    void ensureUniqueConstraints(StageContext ctx, Connection conn, String tobeSchema, String tobeTable,
                                 Map<String, List<UniqueConstraintMeta>> uniqueByTable) {
        List<UniqueConstraintMeta> uks = uniqueByTable.getOrDefault(tobeTable, List.of());
        if (uks.isEmpty()) return;

        boolean prevAutoCommit;
        try { prevAutoCommit = conn.getAutoCommit(); }
        catch (Exception e) {
            log.warn("ensureUniqueConstraints getAutoCommit failed for {}: {}", tobeTable, e.getMessage());
            return;
        }
        try {
            if (!prevAutoCommit) conn.setAutoCommit(true);
            for (UniqueConstraintMeta uk : uks) {
                String sql = PgDdlGenerator.addUniqueConstraintSql(tobeSchema, tobeTable, uk.name(), uk.columns());
                try (Statement st = conn.createStatement()) {
                    st.execute(sql);
                    ingest(ctx, "Ensured UK " + uk.name() + " on " + tobeTable
                            + " (" + String.join(",", uk.columns()) + ")", true);
                } catch (Exception e) {
                    log.warn("ensureUniqueConstraints skip {} ({}): {}", tobeTable, uk.name(), e.getMessage());
                }
            }
        } catch (Exception e) {
            log.warn("ensureUniqueConstraints failed for {}: {}", tobeTable, e.getMessage());
        } finally {
            try { conn.setAutoCommit(prevAutoCommit); } catch (Exception ignored) {}
        }
    }

    /**
     * 적재 후 FK 부착 — NOT VALID 로 추가 후 VALIDATE 분리. 락 최소화.
     * 같은 binding 안의 자식 테이블이 먼저 적재되고 부모는 아직일 수 있어 부모 row 부재 시 VALIDATE 실패 가능 —
     * 그 경우 log 만 남기고 적재 자체는 성공. 운영팀이 사후 VALIDATE 재시도.
     */
    void ensureForeignKeys(StageContext ctx, Connection conn, String tobeSchema, String tobeTable,
                           Map<String, List<ForeignKeyMeta>> fksByTable) {
        List<ForeignKeyMeta> fks = fksByTable.getOrDefault(tobeTable, List.of());
        if (fks.isEmpty()) return;

        boolean prevAutoCommit;
        try { prevAutoCommit = conn.getAutoCommit(); }
        catch (Exception e) {
            log.warn("ensureForeignKeys getAutoCommit failed for {}: {}", tobeTable, e.getMessage());
            return;
        }
        try {
            if (!prevAutoCommit) conn.setAutoCommit(true);
            for (ForeignKeyMeta fk : fks) {
                String addSql = PgDdlGenerator.addForeignKeyNotValidSql(
                        tobeSchema, tobeTable, fk.name(), fk.columns(),
                        fk.refSchema(), fk.refTable(), fk.refColumns(),
                        fk.onDelete(), fk.onUpdate(), fk.deferrableInfo());
                String validateSql = PgDdlGenerator.validateForeignKeySql(tobeSchema, tobeTable, fk.name());
                try (Statement st = conn.createStatement()) {
                    st.execute(addSql);
                } catch (Exception e) {
                    log.warn("ensureForeignKeys ADD skip {} ({}): {}", tobeTable, fk.name(), e.getMessage());
                    continue;
                }
                try (Statement st = conn.createStatement()) {
                    st.execute(validateSql);
                    ingest(ctx, "Ensured FK " + fk.name() + " on " + tobeTable
                            + " (" + String.join(",", fk.columns()) + " -> " + fk.refTable() + ")", true);
                } catch (Exception e) {
                    log.warn("ensureForeignKeys VALIDATE skip {} ({}) — added NOT VALID, validate failed: {}",
                            tobeTable, fk.name(), e.getMessage());
                    ingest(ctx, "FK " + fk.name() + " added NOT VALID on " + tobeTable
                            + " (VALIDATE deferred to operator)", true);
                }
            }
        } catch (Exception e) {
            log.warn("ensureForeignKeys failed for {}: {}", tobeTable, e.getMessage());
        } finally {
            try { conn.setAutoCommit(prevAutoCommit); } catch (Exception ignored) {}
        }
    }

    /** ddl_constraints / ddl_constraint_columns / ddl_foreign_keys 를 묶어서 한 번에 사전 로딩. */
    private void loadConstraintMetas(List<DdlTable> tobeTables,
                                     Map<String, List<UniqueConstraintMeta>> uniqueByTable,
                                     Map<String, List<ForeignKeyMeta>> fksByTable,
                                     Map<String, List<CheckConstraintMeta>> checksByTable) {
        if (tobeTables.isEmpty()) return;
        List<String> tobeTableIds = tobeTables.stream().map(DdlTable::getId).toList();
        Map<String, String> tableNameById = new HashMap<>();
        for (DdlTable t : tobeTables) tableNameById.put(t.getId(), t.getPhysicalName());

        List<DdlConstraint> allUks = ddlConstraintRepo.findByTableIdInAndType(tobeTableIds, DdlConstraint.TYPE_UK);
        List<DdlConstraint> allFks = ddlConstraintRepo.findByTableIdInAndType(tobeTableIds, DdlConstraint.TYPE_FK);
        List<DdlConstraint> allChecks = ddlConstraintRepo.findByTableIdInAndType(tobeTableIds, DdlConstraint.TYPE_CHECK);

        List<String> ukIds = allUks.stream().map(DdlConstraint::getId).toList();
        List<String> fkIds = allFks.stream().map(DdlConstraint::getId).toList();

        Map<String, List<DdlConstraintColumn>> ukColsByCid = ukIds.isEmpty() ? Map.of()
                : ddlConstraintColumnRepo.findByConstraintIdInOrderByOrdinalAsc(ukIds).stream()
                        .collect(Collectors.groupingBy(DdlConstraintColumn::getConstraintId));
        Map<String, List<DdlConstraintColumn>> fkColsByCid = fkIds.isEmpty() ? Map.of()
                : ddlConstraintColumnRepo.findByConstraintIdInOrderByOrdinalAsc(fkIds).stream()
                        .collect(Collectors.groupingBy(DdlConstraintColumn::getConstraintId));
        Map<String, DdlForeignKey> fkRefByCid = fkIds.isEmpty() ? Map.of()
                : ddlForeignKeyRepo.findByConstraintIdIn(fkIds).stream()
                        .collect(Collectors.toMap(DdlForeignKey::getConstraintId, f -> f));

        for (DdlConstraint uk : allUks) {
            String tname = tableNameById.get(uk.getTableId());
            if (tname == null) continue;
            List<DdlConstraintColumn> cols = ukColsByCid.getOrDefault(uk.getId(), List.of());
            UniqueConstraintMeta meta = new UniqueConstraintMeta(uk.getName(),
                    cols.stream().map(DdlConstraintColumn::getColumnName).toList());
            uniqueByTable.computeIfAbsent(tname, k -> new ArrayList<>()).add(meta);
        }

        for (DdlConstraint fkc : allFks) {
            String tname = tableNameById.get(fkc.getTableId());
            if (tname == null) continue;
            DdlForeignKey fk = fkRefByCid.get(fkc.getId());
            if (fk == null) continue;
            List<DdlConstraintColumn> cols = fkColsByCid.getOrDefault(fkc.getId(), List.of());
            ForeignKeyMeta meta = new ForeignKeyMeta(
                    fkc.getName(),
                    cols.stream().map(DdlConstraintColumn::getColumnName).toList(),
                    fk.getRefSchemaName(), fk.getRefTableName(),
                    cols.stream().map(DdlConstraintColumn::getRefColumnName).toList(),
                    fk.getOnDelete(), fk.getOnUpdate(), fk.getDeferrableInfo());
            fksByTable.computeIfAbsent(tname, k -> new ArrayList<>()).add(meta);
        }

        for (DdlConstraint ck : allChecks) {
            String tname = tableNameById.get(ck.getTableId());
            if (tname == null) continue;
            String expr = ck.getCheckExpression();
            if (expr == null || expr.isBlank()) continue;
            checksByTable.computeIfAbsent(tname, k -> new ArrayList<>())
                    .add(new CheckConstraintMeta(ck.getName(), expr));
        }
    }

    /**
     * 적재 후 CHECK 부착 — TO-BE DDL 에 정의된 CHECK 만 (AS-IS Oracle 표현식은 자동 변환 위험으로 부착 X).
     * NOT VALID + VALIDATE 2단계 — 기존 데이터 위반 시 NOT VALID 상태로 남기고 운영팀 사후 정제.
     */
    void ensureCheckConstraints(StageContext ctx, Connection conn, String tobeSchema, String tobeTable,
                                Map<String, List<CheckConstraintMeta>> checksByTable) {
        List<CheckConstraintMeta> checks = checksByTable.getOrDefault(tobeTable, List.of());
        if (checks.isEmpty()) return;

        boolean prevAutoCommit;
        try { prevAutoCommit = conn.getAutoCommit(); }
        catch (Exception e) {
            log.warn("ensureCheckConstraints getAutoCommit failed for {}: {}", tobeTable, e.getMessage());
            return;
        }
        try {
            if (!prevAutoCommit) conn.setAutoCommit(true);
            for (CheckConstraintMeta ck : checks) {
                String addSql = PgDdlGenerator.addCheckConstraintNotValidSql(
                        tobeSchema, tobeTable, ck.name(), ck.checkExpression());
                String validateSql = PgDdlGenerator.validateCheckConstraintSql(tobeSchema, tobeTable, ck.name());
                try (Statement st = conn.createStatement()) {
                    st.execute(addSql);
                } catch (Exception e) {
                    log.warn("ensureCheckConstraints ADD skip {} ({}): {}", tobeTable, ck.name(), e.getMessage());
                    continue;
                }
                try (Statement st = conn.createStatement()) {
                    st.execute(validateSql);
                    ingest(ctx, "Ensured CHECK " + ck.name() + " on " + tobeTable, true);
                } catch (Exception e) {
                    log.warn("ensureCheckConstraints VALIDATE skip {} ({}) — added NOT VALID, validate failed: {}",
                            tobeTable, ck.name(), e.getMessage());
                    ingest(ctx, "CHECK " + ck.name() + " added NOT VALID on " + tobeTable
                            + " (VALIDATE deferred to operator)", true);
                }
            }
        } catch (Exception e) {
            log.warn("ensureCheckConstraints failed for {}: {}", tobeTable, e.getMessage());
        } finally {
            try { conn.setAutoCommit(prevAutoCommit); } catch (Exception ignored) {}
        }
    }

    /**
     * 모든 테이블 적재 후 FK / CHECK 부착 + 위반 감지 (final pass).
     * 부모가 다 적재된 상태라 FK orphan / CHECK 위반은 진짜 신호. 위반 행은 삭제하지 않고
     * WARN quarantine 으로 표면화. ensureForeignKeys/ensureCheckConstraints 가 ADD NOT VALID +
     * VALIDATE 를 수행 — 깨끗하면 제약 확정, 위반이면 VALIDATE 실패로 NOT VALID 유지(기존 동작).
     */
    private void applyDeferredConstraints(StageContext ctx, StageInstance stage, Map<String, Object> dbConfig,
                                          List<MappingTableBinding> bindings,
                                          Map<String, List<ForeignKeyMeta>> fksByTable,
                                          Map<String, List<CheckConstraintMeta>> checksByTable) throws Exception {
        String runId = ctx.getRunHistory().getId();
        if (runControlRegistry.isCancelled(runId)) return;
        boolean any = fksByTable.values().stream().anyMatch(l -> !l.isEmpty())
                || checksByTable.values().stream().anyMatch(l -> !l.isEmpty());
        if (!any) return;

        boolean cutover = ctx.getRunHistory().getRunType()
                == com.ksinfo.modernize_pro_data.coordinator.run.RunType.cutover;
        try (Connection conn = pgCopyManager.openConnection(dbConfig, !cutover)) {
            try { conn.setAutoCommit(true); } catch (Exception ignore) { /* best effort */ }
            for (MappingTableBinding b : bindings) {
                boolean loaded = stageTableResultRepo
                        .findByStageInstanceIdAndBindingId(stage.getId(), b.getId())
                        .map(r -> r.getStatus() == StageTableStatus.success)
                        .orElse(false);
                if (!loaded) continue;   // 적재 실패 테이블엔 제약 부착 안 함.
                String tobeSchema = b.getTobeSchema() == null ? "" : b.getTobeSchema();
                String tobeTable  = b.getTobeTable();
                String tableLabel = tobeSchema.isBlank() ? tobeTable : tobeSchema + "." + tobeTable;

                // FK — 부착 전에 orphan 감지 → WARN. 그다음 기존 ensureForeignKeys 가 ADD+VALIDATE.
                for (ForeignKeyMeta fk : fksByTable.getOrDefault(tobeTable, List.of())) {
                    try {
                        long orphans = countFkOrphans(conn, tobeSchema, tobeTable, fk);
                        if (orphans > 0) {
                            List<List<Object>> sample = sampleFkOrphans(conn, tobeSchema, tobeTable, fk);
                            recordConstraintWarn(ctx, stage, b, tableLabel,
                                    "Referential integrity — " + orphans + " child rows reference missing parent in "
                                            + fk.refTable(),
                                    fk.columns(), sample, orphans);
                        }
                    } catch (Exception e) {
                        log.warn("FK orphan probe failed {} ({}): {}", tobeTable, fk.name(), e.getMessage());
                    }
                }
                ensureForeignKeys(ctx, conn, tobeSchema, tobeTable, fksByTable);

                // CHECK — 부착 전에 위반 감지 → WARN. 그다음 ensureCheckConstraints 가 ADD+VALIDATE.
                for (CheckConstraintMeta ck : checksByTable.getOrDefault(tobeTable, List.of())) {
                    try {
                        long bad = countCheckViolations(conn, tobeSchema, tobeTable, ck);
                        if (bad > 0) {
                            recordConstraintWarn(ctx, stage, b, tableLabel,
                                    "CHECK violation (" + ck.name() + ") — " + bad + " rows fail: " + ck.checkExpression(),
                                    List.of(), List.of(), bad);
                        }
                    } catch (Exception e) {
                        log.warn("CHECK probe failed {} ({}): {}", tobeTable, ck.name(), e.getMessage());
                    }
                }
                ensureCheckConstraints(ctx, conn, tobeSchema, tobeTable, checksByTable);
            }
        }
    }

    /** 자식 FK 값이 부모에 없는 행 수 (NULL FK 값은 미적용=skip). */
    private long countFkOrphans(Connection conn, String schema, String table, ForeignKeyMeta fk) throws Exception {
        String sql = "SELECT count(*) FROM " + pgTableName(schema, table) + " c WHERE "
                + fkNotNullClause(fk) + " AND NOT EXISTS (SELECT 1 FROM "
                + pgTableName(fk.refSchema(), fk.refTable()) + " p WHERE " + fkJoinClause(fk) + ")";
        try (Statement st = conn.createStatement(); ResultSet rs = st.executeQuery(sql)) {
            rs.next();
            return rs.getLong(1);
        }
    }

    private List<List<Object>> sampleFkOrphans(Connection conn, String schema, String table, ForeignKeyMeta fk)
            throws Exception {
        String cols = fk.columns().stream().map(c -> "c." + quoteIdent(c)).collect(Collectors.joining(", "));
        String sql = "SELECT " + cols + " FROM " + pgTableName(schema, table) + " c WHERE "
                + fkNotNullClause(fk) + " AND NOT EXISTS (SELECT 1 FROM "
                + pgTableName(fk.refSchema(), fk.refTable()) + " p WHERE " + fkJoinClause(fk) + ") LIMIT "
                + CONSTRAINT_SAMPLE_LIMIT;
        List<List<Object>> rows = new ArrayList<>();
        try (Statement st = conn.createStatement(); ResultSet rs = st.executeQuery(sql)) {
            int n = rs.getMetaData().getColumnCount();
            while (rs.next()) {
                List<Object> row = new ArrayList<>(n);
                for (int i = 1; i <= n; i++) row.add(rs.getObject(i));
                rows.add(row);
            }
        }
        return rows;
    }

    private String fkNotNullClause(ForeignKeyMeta fk) {
        return fk.columns().stream().map(c -> "c." + quoteIdent(c) + " IS NOT NULL")
                .collect(Collectors.joining(" AND "));
    }

    private String fkJoinClause(ForeignKeyMeta fk) {
        List<String> cols = fk.columns();
        List<String> ref = fk.refColumns();
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < cols.size(); i++) {
            if (i > 0) sb.append(" AND ");
            sb.append("p.").append(quoteIdent(ref.get(i))).append(" = c.").append(quoteIdent(cols.get(i)));
        }
        return sb.toString();
    }

    /** CHECK 식이 FALSE 인 행 수. NULL(unknown)은 CHECK 통과라 NOT (expr) 에서 자연히 제외. */
    private long countCheckViolations(Connection conn, String schema, String table, CheckConstraintMeta ck)
            throws Exception {
        String sql = "SELECT count(*) FROM " + pgTableName(schema, table)
                + " WHERE NOT (" + ck.checkExpression() + ")";
        try (Statement st = conn.createStatement(); ResultSet rs = st.executeQuery(sql)) {
            rs.next();
            return rs.getLong(1);
        }
    }

    /** 제약 위반을 severity=warning Quarantine 으로 기록 (Load 차단 안 함). */
    private void recordConstraintWarn(StageContext ctx, StageInstance stage, MappingTableBinding binding,
                                      String tableLabel, String reason,
                                      List<String> columns, List<List<Object>> sampleRows, long count) {
        Map<String, Object> data = new HashMap<>();
        data.put("reason", reason);
        data.put("detail", tableLabel + " — " + reason);
        data.put("severity", "warning");
        data.put("stageLabel", "Load");
        data.put("table", tableLabel);
        data.put("columns", columns);
        data.put("columnRoles", columns.stream().map(c -> "violated").toList());
        data.put("sampleRows", sampleRows);
        quarantineService.record(ctx.getRunHistory().getId(), stage.getId(), binding.getId(),
                null, reason, QuarantineSeverity.warning, data, count, ctx.getLogLineSeqCursor());
        ingest(ctx, "Load WARN — " + reason + " (" + tableLabel + ")", true);
    }

    record UniqueConstraintMeta(String name, List<String> columns) {}

    record ForeignKeyMeta(String name, List<String> columns,
                          String refSchema, String refTable, List<String> refColumns,
                          String onDelete, String onUpdate, String deferrableInfo) {}

    record CheckConstraintMeta(String name, String checkExpression) {}

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

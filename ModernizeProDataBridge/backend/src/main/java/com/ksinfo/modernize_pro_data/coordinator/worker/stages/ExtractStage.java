package com.ksinfo.modernize_pro_data.coordinator.worker.stages;

import com.ksinfo.modernize_pro_data.common.duckdb.DuckDbService;
import com.ksinfo.modernize_pro_data.coordinator.mapping.MappingTableBinding;
import com.ksinfo.modernize_pro_data.coordinator.mapping.MappingTableBindingRepository;
import com.ksinfo.modernize_pro_data.coordinator.mapping.MappingTableBindingSource;
import com.ksinfo.modernize_pro_data.coordinator.quarantine.QuarantineService;
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
import org.springframework.stereotype.Service;

import java.nio.file.Path;
import java.nio.file.Paths;
import java.sql.ResultSet;
import java.sql.ResultSetMetaData;
import java.sql.Statement;
import java.time.Duration;
import java.time.OffsetDateTime;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Extract stage — AS-IS CSV → DuckDB load + parquet1 dump.
 *
 * 흐름:
 *   1. CREATE SCHEMA IF NOT EXISTS "{ctx.duckdbSchema}"
 *   2. 각 binding 별 — binding.getSources() 의 각 AS-IS source 테이블을 load:
 *      - CSV path resolve (site.csv_path + {asis_table}.csv)
 *      - CREATE OR REPLACE TABLE schema.asis_{asis_table} AS SELECT * FROM read_csv_auto(...)
 *      - row_count 합산, parquet1 dump = 'parquet1/{asis_table}.parquet'
 *   3. 같은 asis_table 이 여러 source/binding 에 나오면 한 번만 load (중복 제거)
 *
 * JOIN/UNION 은 TransformStage 가 asis_{asis_table} 들을 결합. 여기선 source 테이블만 적재.
 * composition_kind=none (sources 없음) 은 load 없이 success.
 * continue-on-error: binding 별 try/catch, 하나 실패해도 다음 진행.
 */
@Service
@RequiredArgsConstructor
@Slf4j
public class ExtractStage implements StageRunner {

    private static final String STAGE_KEY = "extract";

    private final StageInstanceRepository stageInstanceRepo;
    private final StageTableResultRepository stageTableResultRepo;
    private final MappingTableBindingRepository bindingRepo;
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

        for (MappingTableBinding childBinding : bindings) {
            ctx.throwIfCancelled();   // abort/timeout 신호 시 RunCancelledException → LocalWorkerExecutor 가 stage failed 마킹.
            // 자식 link swap — sources 가 master 에 있으므로 csv → parquet 도 master sources 기준.
            MappingTableBinding binding = childBinding;
            if (childBinding.getSharedFromProjectId() != null) {
                String masterPid = childBinding.getSharedFromProjectId();
                String mSchema = childBinding.getTobeSchema() == null ? "" : childBinding.getTobeSchema();
                MappingTableBinding mb = bindingRepo
                        .findByProjectIdAndTobeSchemaAndTobeTable(masterPid, mSchema, childBinding.getTobeTable())
                        .orElse(null);
                if (mb != null) binding = mb;
            }
            String childBindingId = childBinding.getId();
            OffsetDateTime tableStart = OffsetDateTime.now();
            String tobeSchema = binding.getTobeSchema() == null ? "" : binding.getTobeSchema();
            String tobeTable  = binding.getTobeTable();
            String tableLabel = tobeSchema.isBlank() ? tobeTable : tobeSchema + "." + tobeTable;

            StageTableResult result = stageTableResultRepo
                    .findByStageInstanceIdAndBindingId(stage.getId(), childBindingId)
                    .orElseGet(() -> StageTableResult.create(stage.getId(), childBindingId, tobeSchema, tobeTable));
            result.setStartedAt(tableStart);

            try {
                Path baseDir = Paths.get(site.getCsvPath()).toAbsolutePath().normalize();

                // binding 의 distinct AS-IS source 테이블 (ordinal 순). composition_kind=none 이면 빈 list.
                // distinct AS-IS source 테이블 (ordinal 순, 중복 제거). value = asis_schema (CSV 파일 해석용, null 가능).
                Map<String, String> asisTableToSchema = new LinkedHashMap<>();
                for (MappingTableBindingSource src : binding.getSources()) {
                    if (src.getAsisTable() != null && !src.getAsisTable().isBlank()) {
                        asisTableToSchema.putIfAbsent(src.getAsisTable(), src.getAsisSchema());
                    }
                }

                String asisEncoding = site.getAsisEncoding();
                /* UTF-8 source (default) 는 character replacement / type inference 부담 X.
                   sample_size 축소 + scanForReplacementChars skip → 대용량 환경 read 시간 ↓.
                   (2026-05-31 perf 라운드 P0-2) */
                boolean isUtf8 = asisEncoding == null || asisEncoding.isBlank()
                        || "utf-8".equalsIgnoreCase(asisEncoding.trim())
                        || "utf8".equalsIgnoreCase(asisEncoding.trim());
                String encodingClause = encodingClause(asisEncoding);
                String sampleSizeClause = isUtf8 ? ", sample_size=10000" : ", sample_size=-1";

                long totalRows = 0;
                long fpMtime = 0L; long fpSize = 0L;   // AS-IS CSV fingerprint (WARN ack carry-over, 정책 3·6)
                for (Map.Entry<String, String> entry : asisTableToSchema.entrySet()) {
                    ctx.throwIfCancelled();   // (D) sub-step — 각 source CSV 처리 시작 전 cancel 체크.
                    String asisTable = entry.getKey();
                    Path csv = StageHelpers.resolveCsvFile(baseDir, entry.getValue(), asisTable);
                    if (csv == null) {
                        String qualified = (entry.getValue() != null && !entry.getValue().isBlank())
                                ? entry.getValue() + "." + asisTable : asisTable;
                        throw new IllegalStateException("CSV not found: " + qualified + ".csv");
                    }
                    try {
                        fpMtime = Math.max(fpMtime, java.nio.file.Files.getLastModifiedTime(csv).toMillis());
                        fpSize += java.nio.file.Files.size(csv);
                    } catch (java.io.IOException ignore) {
                        /* fingerprint 수집 실패 — 추출은 그대로 진행, carry-over 만 비활성(안전). */
                    }

                    // 입력 가드 (2026-07-08 UTF-8 계약) — read_csv 로 넘기기 전에 파일을 1 회 스캔.
                    // NUL(0x00) / 깨진 UTF-8 은 fail-fast (그냥 넘기면 U+FFFD silent 치환 또는 PG 적재 시
                    // cryptic error). BOM 은 감지만 (DuckDB read_csv 가 strip).
                    try {
                        com.ksinfo.modernize_pro_data.common.util.CsvInputGuard.Result guard =
                                com.ksinfo.modernize_pro_data.common.util.CsvInputGuard.inspect(csv);
                        if (!guard.ok()) {
                            throw new IllegalStateException("AS-IS CSV 입력 가드 위반 (" + asisTable
                                    + ".csv, byte offset " + guard.offset() + "): " + guard.reason()
                                    + " — 입력은 UTF-8 이어야 합니다");
                        }
                        if (guard.bom()) {
                            log.warn("[extract] {}.csv 에 UTF-8 BOM 감지 — read_csv 가 strip (첫 컬럼명 확인 권장)", asisTable);
                        }
                    } catch (java.io.IOException e) {
                        throw new IllegalStateException("AS-IS CSV 읽기 실패 (" + asisTable + ".csv): " + e.getMessage(), e);
                    }

                    String escapedPath = csv.toString().replace("'", "''");
                    String fqTable = quoteIdent(schema) + "." + quoteIdent("asis_" + asisTable);

                    try (Statement st = duckDbService.statement()) {
                        ctx.throwIfCancelled();   // (D) sub-step — DuckDB CREATE TABLE AS SELECT FROM read_csv_auto (대용량 CSV read) 직전 cancel 체크.
                        // runCancellable: 대용량 CSV read 도중 abort 시 statement.cancel() 로 즉시 interrupt
                        // (직전 체크만으로는 이 쿼리가 끝날 때까지 못 멈추던 갭).
                        ctx.runCancellable(st, () -> st.execute("CREATE OR REPLACE TABLE " + fqTable
                                + " AS SELECT * FROM read_csv_auto('" + escapedPath
                                + "', header=true, all_varchar=true" + sampleSizeClause + encodingClause + ")"));

                        try (ResultSet rs = st.executeQuery("SELECT COUNT(*) FROM " + fqTable)) {
                            rs.next();
                            totalRows += rs.getLong(1);
                        }

                        Path parquet = ctx.parquet1Dir().resolve(asisTable + ".parquet");
                        String escapedParquet = parquet.toString().replace("\\", "/").replace("'", "''");
                        ctx.throwIfCancelled();   // (D) sub-step — parquet dump 직전 cancel 체크 (디스크 IO 큰 부분).
                        ctx.runCancellable(st, () -> st.execute("COPY " + fqTable + " TO '" + escapedParquet + "' (FORMAT PARQUET)"));
                    }
                    /* Step 3 — DuckDB 가 invalid byte 만났을 때 throw 안 하고 U+FFFD (대체 문자) 로
                       silent 치환. 정상 read 통과한 것 같지만 데이터 일부 손상.
                       각 asis 컬럼에 U+FFFD 있나 COUNT — 발견 시 quarantine 카드 (stageLabel='encode').
                       UTF-8 source 는 valid byte 시퀀스 보장 → skip (2026-05-31 perf P0-2). */
                    if (!isUtf8) {
                        scanForReplacementChars(ctx, stage, childBindingId, tableLabel, schema, asisTable);
                    }
                    ingest(ctx, "Extracted source " + asisTable + " (binding " + tobeTable + ")", true);
                }

                // CSV fingerprint 저장 — Validation 의 WARN ack carry-over 매칭용 (key = 검증이 쓰는 childBindingId).
                if (fpSize > 0) {
                    ctx.putCsvFingerprint(childBindingId, fpMtime, fpSize);
                }

                OffsetDateTime tableEnd = OffsetDateTime.now();
                result.setStatus(StageTableStatus.success);
                result.setRowCount(totalRows);
                result.setFinishedAt(tableEnd);
                result.setDurationMs(Duration.between(tableStart, tableEnd).toMillis());
                stageTableResultRepo.save(result);

                ingest(ctx, "Extracted " + tobeTable + ": " + asisTableToSchema.size()
                        + " source(s), " + totalRows + " rows total", true);
                successCount++;
                stage.setTablesSuccess(successCount);
                stage.setTablesFailed(failedCount);
                stageInstanceRepo.save(stage);
                broadcaster.stageProgress(runId, stage);
            } catch (com.ksinfo.modernize_pro_data.coordinator.worker.RunCancelledException ce) {
                // cancel(statement interrupt 포함)은 table 실패가 아니라 run 중단 — quarantine 카드
                // 없이 그대로 전파해 LocalWorkerExecutor 가 stage 를 cancelled 로 처리하게 한다.
                throw ce;
            } catch (Exception e) {
                OffsetDateTime tableEnd = OffsetDateTime.now();
                result.setStatus(StageTableStatus.failed);
                Map<String, Object> detail = new HashMap<>();
                detail.put("message", e.getMessage());
                result.setErrorDetail(detail);
                result.setFinishedAt(tableEnd);
                result.setDurationMs(Duration.between(tableStart, tableEnd).toMillis());
                stageTableResultRepo.save(result);

                /* Step 1 — binding-level 실패를 Quarantine 카드로 노출. */
                StageHelpers.recordStageFailureQuarantine(ctx, quarantineService, stage, childBinding,
                        tableLabel, "Extract", "extract.failure", e.getMessage());

                log.warn("ExtractStage failed for binding {} ({}): {}", childBindingId, tobeTable, e.getMessage());
                ingest(ctx, "Extract failed for " + tableLabel + ": " + e.getMessage(), false);
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

    /**
     * Step 3 — DuckDB read_csv_auto 가 invalid byte 만났을 때 자동으로 U+FFFD (REPLACEMENT
     * CHARACTER, codepoint 65533) 로 silent 치환. read 자체는 성공하지만 데이터 일부 손상.
     *
     * 모든 컬럼에 U+FFFD 가 들어있는 row 가 있는지 COUNT — 있으면 Quarantine 카드 (stageLabel='encode').
     * sample 최대 5 행 = 컬럼/값/위치. FE 의 humanizeQuarantineDetail 의 'encode' case 가 처리.
     *
     * 한계: 데이터에 정당하게 들어있는 U+FFFD 도 catch (false positive 드물지만 가능) — 카드 메시지에
     * 명시. 본격 Source Reader SPI (PoC2) 에선 invalid byte 발견 시점에 정확한 line / column / 원본 byte 보고.
     */
    private void scanForReplacementChars(StageContext ctx, StageInstance stage,
                                         String childBindingId, String tableLabel,
                                         String schema, String asisTable) {
        String fqTable = quoteIdent(schema) + "." + quoteIdent("asis_" + asisTable);
        try (Statement st = duckDbService.statement()) {
            /* 컬럼 list 동적 수집 — all_varchar=true 로 적재됐으므로 모두 VARCHAR. */
            java.util.List<String> cols = new java.util.ArrayList<>();
            try (ResultSet rs = st.executeQuery("SELECT * FROM " + fqTable + " LIMIT 0")) {
                ResultSetMetaData md = rs.getMetaData();
                for (int i = 1; i <= md.getColumnCount(); i++) cols.add(md.getColumnLabel(i));
            }
            if (cols.isEmpty()) return;

            /* 어느 행에 U+FFFD 가 있는지 OR 조합. POSITION(CHR(65533) IN col) > 0. */
            String orCondition = cols.stream()
                    .map(c -> "POSITION(CHR(65533) IN COALESCE(" + quoteIdent(c) + ", '')) > 0")
                    .collect(java.util.stream.Collectors.joining(" OR "));

            long count;
            try (ResultSet rs = st.executeQuery("SELECT COUNT(*) FROM " + fqTable + " WHERE " + orCondition)) {
                rs.next();
                count = rs.getLong(1);
            }
            if (count <= 0) return;

            /* sample 5행 추출 — 첫 컬럼 (PK 추정) + U+FFFD 들어있는 컬럼명/값. */
            int sampleLimit = 5;
            java.util.List<java.util.List<Object>> samples = new java.util.ArrayList<>();
            String selectCols = cols.stream().map(ExtractStage::quoteIdent)
                    .collect(java.util.stream.Collectors.joining(", "));
            try (ResultSet rs = st.executeQuery(
                    "SELECT " + selectCols + " FROM " + fqTable + " WHERE " + orCondition + " LIMIT " + sampleLimit)) {
                int colCount = cols.size();
                while (rs.next()) {
                    java.util.List<Object> row = new java.util.ArrayList<>(2);
                    /* row 식별자 — 첫 컬럼 값. */
                    row.add(rs.getObject(1));
                    /* 어느 컬럼에 U+FFFD 가 있는지 컬럼명:값 형태로 합쳐 둠. */
                    StringBuilder hits = new StringBuilder();
                    for (int i = 1; i <= colCount; i++) {
                        String v = rs.getString(i);
                        if (v != null && v.indexOf((char) 0xFFFD) >= 0) {
                            if (hits.length() > 0) hits.append("; ");
                            hits.append(cols.get(i - 1)).append("=").append(v);
                        }
                    }
                    row.add(hits.toString());
                    samples.add(row);
                }
            }

            java.util.Map<String, Object> data = new java.util.HashMap<>();
            data.put("reason", "Encoding corruption (auto-replaced)");
            data.put("detail", tableLabel + ": " + count + " row(s) contain U+FFFD replacement char "
                    + "(invalid bytes auto-substituted by DuckDB during CSV read)");
            data.put("severity", "error");
            data.put("stageLabel", "encode");
            data.put("table", tableLabel);
            data.put("columns", java.util.List.of(cols.get(0), "U+FFFD locations"));
            data.put("columnRoles", java.util.List.of("pk", "violated"));
            data.put("sampleRows", samples);

            quarantineService.record(
                    ctx.getRunHistory().getId(),
                    stage.getId(),
                    childBindingId,
                    null,
                    "Encoding corruption — " + tableLabel,
                    com.ksinfo.modernize_pro_data.coordinator.quarantine.QuarantineSeverity.error,
                    data,
                    count,
                    ctx.getLogLineSeqCursor());
            ingest(ctx, "Encoding corruption detected in " + tableLabel + " (" + count + " rows)", false);
        } catch (Exception e) {
            // scan 자체 실패해도 Extract 정상 진행 — silent corruption 미감지는 아쉽지만 stage fail 시키지 X.
            log.warn("U+FFFD scan failed for {}: {}", tableLabel, e.getMessage());
        }
    }

    /** DuckDB identifier (schema / table) double-quote escape. */
    private static String quoteIdent(String name) {
        return "\"" + name.replace("\"", "\"\"") + "\"";
    }

    /**
     * read_csv 의 encoding 절 — 항상 빈 문자열(파이프라인 입력 계약 = UTF-8, 2026-07-08).
     * DuckDB encodings 확장 제거로 encoding= 을 쓰지 않는다. 비-UTF-8 입력은 {@link CsvInputGuard}
     * 가 reject 한다. (asisEncoding 파라미터는 호환용으로 남기되 무시.)
     */
    private static String encodingClause(String asisEncoding) {
        return "";
    }
}

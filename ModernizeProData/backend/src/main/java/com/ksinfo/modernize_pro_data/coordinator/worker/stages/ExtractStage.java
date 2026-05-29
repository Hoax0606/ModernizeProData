package com.ksinfo.modernize_pro_data.coordinator.worker.stages;

import com.ksinfo.modernize_pro_data.common.duckdb.DuckDbService;
import com.ksinfo.modernize_pro_data.coordinator.mapping.MappingTableBinding;
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
            String tableLabel = tobeSchema.isBlank() ? tobeTable : tobeSchema + "." + tobeTable;

            StageTableResult result = stageTableResultRepo
                    .findByStageInstanceIdAndBindingId(stage.getId(), binding.getId())
                    .orElseGet(() -> StageTableResult.create(stage.getId(), binding.getId(), tobeSchema, tobeTable));
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

                String encodingClause = encodingClause(site.getAsisEncoding());

                long totalRows = 0;
                for (Map.Entry<String, String> entry : asisTableToSchema.entrySet()) {
                    String asisTable = entry.getKey();
                    Path csv = StageHelpers.resolveCsvFile(baseDir, entry.getValue(), asisTable);
                    if (csv == null) {
                        String qualified = (entry.getValue() != null && !entry.getValue().isBlank())
                                ? entry.getValue() + "." + asisTable : asisTable;
                        throw new IllegalStateException("CSV not found: " + qualified + ".csv");
                    }
                    String escapedPath = csv.toString().replace("'", "''");
                    String fqTable = quoteIdent(schema) + "." + quoteIdent("asis_" + asisTable);

                    try (Statement st = duckDbService.statement()) {
                        st.execute("CREATE OR REPLACE TABLE " + fqTable
                                + " AS SELECT * FROM read_csv_auto('" + escapedPath
                                + "', header=true, sample_size=-1, all_varchar=true" + encodingClause + ")");

                        try (ResultSet rs = st.executeQuery("SELECT COUNT(*) FROM " + fqTable)) {
                            rs.next();
                            totalRows += rs.getLong(1);
                        }

                        Path parquet = ctx.parquet1Dir().resolve(asisTable + ".parquet");
                        String escapedParquet = parquet.toString().replace("\\", "/").replace("'", "''");
                        st.execute("COPY " + fqTable + " TO '" + escapedParquet + "' (FORMAT PARQUET)");
                    }
                    /* Step 3 — DuckDB 가 invalid byte 만났을 때 throw 안 하고 U+FFFD (대체 문자) 로
                       silent 치환. 정상 read 통과한 것 같지만 데이터 일부 손상.
                       각 asis 컬럼에 U+FFFD 있나 COUNT — 발견 시 quarantine 카드 (stageLabel='encode'). */
                    scanForReplacementChars(ctx, stage, binding, tableLabel, schema, asisTable);
                    ingest(ctx, "Extracted source " + asisTable + " (binding " + tobeTable + ")", true);
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
                StageHelpers.recordStageFailureQuarantine(ctx, quarantineService, stage, binding,
                        tableLabel, "Extract", "extract.failure", e.getMessage());

                log.warn("ExtractStage failed for binding {} ({}): {}", binding.getId(), tobeTable, e.getMessage());
                ingest(ctx, "Extract failed for " + tableLabel + ": " + e.getMessage(), false);
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
                                         MappingTableBinding binding, String tableLabel,
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
                    binding.getId(),
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
     * site.asisEncoding → read_csv 의 encoding 절 (앞에 ", " 포함, 없으면 빈 문자열).
     *   - utf-8 / blank → "" (DuckDB native, 확장 불필요)
     *   - shift_jis → ", encoding='shift_jis'" (encodings 확장)
     *   - euc-jp    → ", encoding='EUC_JP'"   (encodings 확장 — 이름 형식 주의: 대문자+언더스코어)
     *   - ebcdic    → 미지원 (UI 안내대로 Java 전처리는 추후 Source Reader) → 예외
     *   - 그 외      → 그대로 시도 (확장이 인식하면 동작)
     */
    private static String encodingClause(String asisEncoding) {
        if (asisEncoding == null || asisEncoding.isBlank()) return "";
        switch (asisEncoding.trim().toLowerCase()) {
            case "utf-8":
            case "utf8":
                return "";
            case "shift_jis":
            case "shift-jis":
            case "sjis":
                return ", encoding='shift_jis'";
            case "euc-jp":
            case "euc_jp":
            case "eucjp":
                return ", encoding='EUC_JP'";
            case "ebcdic":
                throw new IllegalStateException(
                        "EBCDIC 는 DuckDB extract 경로 미지원 — Java 전처리(추후 Source Reader) 필요");
            default:
                return ", encoding='" + asisEncoding.trim().replace("'", "''") + "'";
        }
    }
}

package com.ksinfo.modernize_pro_data.coordinator.worker.stages;

import com.ksinfo.modernize_pro_data.common.duckdb.DuckDbService;
import com.ksinfo.modernize_pro_data.coordinator.ddl.DdlColumn;
import com.ksinfo.modernize_pro_data.coordinator.ddl.DdlColumnRepository;
import com.ksinfo.modernize_pro_data.coordinator.ddl.DdlTable;
import com.ksinfo.modernize_pro_data.coordinator.ddl.DdlTableRepository;
import com.ksinfo.modernize_pro_data.coordinator.mapping.MappingTableBinding;
import com.ksinfo.modernize_pro_data.coordinator.quarantine.QuarantineService;
import com.ksinfo.modernize_pro_data.coordinator.quarantine.QuarantineSeverity;
import com.ksinfo.modernize_pro_data.coordinator.run.RunType;
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

import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.ResultSet;
import java.sql.ResultSetMetaData;
import java.sql.Statement;
import java.time.Duration;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Audit stage — TO-BE DDL 의 제약 평가 (전수 검사, Load 전).
 *
 * 각 binding 의 각 TO-BE 컬럼에 대해 4종 검사:
 *   - NOT NULL : nullable=false 인데 IS NULL                       (validate.notnull)
 *   - length   : LENGTH(col) > col.length                          (validate.length)
 *   - type     : TRY_CAST(col AS {숫자/날짜/타임스탬프}) 실패        (validate.type)
 *   - range    : 숫자지만 DECIMAL(precision,scale) 자릿수 초과       (validate.range)
 *   - PK unique: TO-BE PK 컬럼 조합이 2회 이상 (중복 키)             (validate.pk_unique, 테이블 단위)
 *
 * 위반 검출 시 검사별로 Quarantine 기록 (severity=error, sample 5 row).
 * char/varchar 는 type/range skip. continue-on-error: binding 단위 try/catch.
 */
@Service
@RequiredArgsConstructor
@Slf4j
public class AuditStage implements StageRunner {

    private static final String STAGE_KEY = "audit";
    /**
     * quarantine sample row 상한.
     *
     * 2026-05-29: 팀장 지시로 5 → 전수 표시 (Integer.MAX_VALUE).
     * 2026-06-01: 실 BANKSYS transaction_monthly run 에서 OOM (Java heap space) 발생 →
     *             1000 으로 cap. 전수 보존은 {@link #exportViolationParquet} 의 parquet
     *             (위반 row 전체) 에 의존, JSONB sample 은 1000 까지만.
     *
     * 결정 배경: docs/handoff/2026-05-29-quarantine-show-all-decision.md +
     * AuditStage OOM 인시던트 노트 (2026-06-01).
     */
    private static final int SAMPLE_LIMIT = 1000;

    private final StageInstanceRepository stageInstanceRepo;
    private final StageTableResultRepository stageTableResultRepo;
    private final DdlTableRepository ddlTableRepo;
    private final DdlColumnRepository ddlColumnRepo;
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
        // 위반 발생 binding 수 — stage 자체의 status 표시용 (StageTableResult 는 success 유지, Load 는 정상 진행).
        // FE 에 "Audit 에서 위반 발견" 을 즉시 보여주기 위해 stage.status=failed 마킹의 근거.
        int quarantinedCount = 0;
        // row-level Quarantine separation — 위반 row 를 DuckDB tobe_ 에서 DELETE 분리,
        // 정상 row 만 Load 까지. sample 5행은 QuarantineService 가 이미 기록, 전수는 parquet 보존.
        // 2026-05-29: cutover 도 동일 적용 (이전엔 cutover 만 strict — 분리 없이 fail).
        // 근거: green-field 배포 모델에선 분리 후 정상 row 적재가 합리적. docs/ONBOARDING.md §Cutover 참조.
        boolean separateViolations = true;

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
                /* Quarantine 표시용 — schema 있으면 'banksys.customers' 식 식별성 강한 라벨. */
                String tableLabel = tobeSchema.isBlank() ? tobeTable : tobeSchema + "." + tobeTable;
                String pkCol = cols.stream()
                        .filter(c -> c.getPkOrder() != null)
                        .findFirst()
                        .map(DdlColumn::getPhysicalName)
                        .orElse(cols.isEmpty() ? null : cols.get(0).getPhysicalName());

                /* 위반 row 분리용 WHERE 조건 모음 — 모든 검사가 추가, 마지막에 UNION (OR) 으로 DELETE. */
                List<String> rowFilters = new ArrayList<>();
                int violations = 0;

                /* 2026-05-31 P1-6 — column×4 check 풀스캔 통합.
                   이전: col 마다 NOT NULL/length/type/range 별도 COUNT(*) — col 20 × 4 = 80+ 풀스캔.
                   이후: 1 query 에 모든 check 의 위반 count 를 CASE WHEN SUM 으로 묶음 → 1 풀스캔.
                   위반 발견된 check 만 sample fetch + quarantine. */
                List<CheckSpec> allChecks = new ArrayList<>();
                for (DdlColumn col : cols) {
                    allChecks.addAll(buildColumnChecks(col));
                }
                if (!allChecks.isEmpty()) {
                    long[] counts = runAggregatedChecks(fqTobe, allChecks);
                    for (int i = 0; i < allChecks.size(); i++) {
                        if (counts[i] > 0) {
                            CheckSpec spec = allChecks.get(i);
                            violations += processViolation(ctx, stage, binding, fqTobe, tableLabel, pkCol,
                                    spec.colName(), spec.whereCond(), spec.reason(), spec.stageLabel(),
                                    counts[i], rowFilters);
                        }
                    }
                }
                // PK 중복(uniqueness) — 테이블 단위 검사 (GROUP BY 라 별도 유지)
                violations += checkPkUniqueness(ctx, stage, binding, fqTobe, tableLabel, cols, rowFilters);

                long separated = 0;
                Path quarantineParquet = null;
                if (separateViolations && !rowFilters.isEmpty()) {
                    String unionWhere = "(" + String.join(") OR (", rowFilters) + ")";
                    /* 1) DELETE 前に위반 row 를 parquet 으로 영구 보존 — sample 5행 (QuarantineEntry)
                          만으론 전수 추적 불가능했던 한계를 해소. 같은 binding 의 모든 위반(NOT NULL
                          gender + NOT NULL birth_date 등) 이 하나의 파일에 합쳐짐. */
                    quarantineParquet = exportViolationParquet(ctx, fqTobe, tobeTable, unionWhere);
                    /* 2) DuckDB tobe_ 에서 제거 → Load 가 정상 row 만 적재. */
                    separated = deleteWhere(fqTobe, unionWhere);
                    ingest(ctx, "Quarantine separated " + separated + " row(s) from " + tableLabel
                            + (quarantineParquet != null ? " → " + quarantineParquet.getFileName() : ""), true);
                }

                OffsetDateTime tableEnd = OffsetDateTime.now();
                if (violations > 0 && !separateViolations) {
                    // cutover — 분리 안 함, 기존 동작 유지
                    result.setStatus(StageTableStatus.failed);
                    Map<String, Object> detail = new HashMap<>();
                    detail.put("message", violations + " validation violation(s)");
                    result.setErrorDetail(detail);
                    failedCount++;
                } else {
                    result.setStatus(StageTableStatus.success);
                    if (violations > 0) {
                        Map<String, Object> detail = new HashMap<>();
                        detail.put("message", violations + " violation(s) quarantined, " + separated + " row(s) separated");
                        detail.put("violations", violations);
                        detail.put("rowsSeparated", separated);
                        if (quarantineParquet != null) {
                            /* FE 다운로드 endpoint 가 path 로 파일 stream — Quarantine 카드의
                               "Download all rows" 액션이 이 경로 사용 가능. */
                            detail.put("quarantineParquet", quarantineParquet.toString());
                        }
                        result.setErrorDetail(detail);
                        quarantinedCount++;
                    }
                    successCount++;
                }
                result.setFinishedAt(tableEnd);
                result.setDurationMs(Duration.between(tableStart, tableEnd).toMillis());
                stageTableResultRepo.save(result);
                stage.setTablesSuccess(successCount);
                stage.setTablesFailed(failedCount);
                stageInstanceRepo.save(stage);
                broadcaster.stageProgress(runId, stage);
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
        /* stage.status — failedCount > 0 (실패) OR quarantinedCount > 0 (위반 발견) 면 failed 표시.
           StageTableResult 는 success 유지 (Load 의 upstreamFailed 통과 → 정상 row 적재).
           "AuditStage 가 위반 발견" 을 ExecutionPage pipeline 칩에 즉시 노출 (2026-05-29). */
        boolean hasIssues = failedCount > 0 || quarantinedCount > 0;
        stage.setStatus(hasIssues ? StageStatus.failed : StageStatus.success);
        if (quarantinedCount > 0 && failedCount == 0) {
            stage.setErrorSummary(quarantinedCount + " table(s) with violations — rows quarantined, downstream continues");
        }
        stageInstanceRepo.save(stage);

        ingest(ctx, "Stage audit completed — " + successCount + " success, " + failedCount + " failed, "
                + quarantinedCount + " with violations", true);
        log.info("AuditStage success={} failed={} quarantined={}",
                successCount, failedCount, quarantinedCount);
    }

    /**
     * 한 컬럼에 적용 가능한 검사(NOT NULL / length / type / range)를 모두 수행.
     * 위반된 검사 종류 수를 반환 (각 위반은 Quarantine 1 row). rowFilters 에 위반 WHERE 조건 누적.
     *
     * @param tableLabel 사용자 표시용 테이블 식별자 (schema 있으면 'schema.table', 없으면 'table').
     *                   SQL 식별자가 아님 — quarantine sampleData / 로그 메시지에서만 사용.
     */
    /** column 별 4 check 의 spec (count 안 함, query 만들기용). 2026-05-31 P1-6. */
    private record CheckSpec(String colName, String stageLabel, String reason, String whereCond) {}

    /** col 의 4 종 check (NOT NULL / length / type / range) 의 spec 생성. 실제 count 는 통합 query. */
    private static List<CheckSpec> buildColumnChecks(DdlColumn col) {
        List<CheckSpec> checks = new ArrayList<>();
        String colName = col.getPhysicalName();
        String q = quoteIdent(colName);

        if (!col.isNullable()) {
            checks.add(new CheckSpec(colName, "validate.notnull",
                    "NOT NULL violation",
                    q + " IS NULL"));
        }
        Integer len = col.getLength();
        if (len != null && len > 0 && isStringType(col.getDataType())) {
            checks.add(new CheckSpec(colName, "validate.length",
                    "Length > " + len,
                    "LENGTH(CAST(" + q + " AS VARCHAR)) > " + len + " AND " + q + " IS NOT NULL"));
        }
        String castType = duckCastType(col);
        if (castType != null) {
            checks.add(new CheckSpec(colName, "validate.type",
                    "Type cast failed (" + castType + ")",
                    "TRY_CAST(" + q + " AS " + castType + ") IS NULL AND " + q + " IS NOT NULL"
                            + " AND TRIM(CAST(" + q + " AS VARCHAR)) <> ''"));
        }
        if (isNumeric(col) && col.getPrecision() != null) {
            int p = col.getPrecision();
            int s = col.getScale() == null ? 0 : col.getScale();
            if (p > 0 && p <= 38 && s >= 0 && s <= p) {
                checks.add(new CheckSpec(colName, "validate.range",
                        "Numeric out of range DECIMAL(" + p + "," + s + ")",
                        "TRY_CAST(" + q + " AS DECIMAL(" + p + "," + s + ")) IS NULL"
                                + " AND TRY_CAST(" + q + " AS DOUBLE) IS NOT NULL"));
            }
        }
        return checks;
    }

    /** 모든 check 의 위반 count 를 1 query 로 통합. CASE WHEN SUM 패턴 — 1 풀스캔. */
    private long[] runAggregatedChecks(String fqTobe, List<CheckSpec> checks) throws Exception {
        StringBuilder sb = new StringBuilder("SELECT ");
        for (int i = 0; i < checks.size(); i++) {
            if (i > 0) sb.append(", ");
            sb.append("SUM(CASE WHEN ").append(checks.get(i).whereCond())
              .append(" THEN 1 ELSE 0 END)");
        }
        sb.append(" FROM ").append(fqTobe);
        try (Statement st = duckDbService.statement();
             ResultSet rs = st.executeQuery(sb.toString())) {
            rs.next();
            long[] counts = new long[checks.size()];
            for (int i = 0; i < checks.size(); i++) {
                String v = rs.getString(i + 1);
                counts[i] = (v == null || v.isBlank()) ? 0L : Long.parseLong(v.trim());
            }
            return counts;
        }
    }

    /** 위반 발견된 check 1 건 처리 — sample fetch + quarantine 기록 + rowFilters 누적. */
    private int processViolation(StageContext ctx, StageInstance stage, MappingTableBinding binding,
                                 String fqTobe, String tableLabel, String pkCol, String colName,
                                 String whereCond, String reason, String stageLabel,
                                 long count, List<String> rowFilters) throws Exception {
        List<List<Object>> samples = fetchSamples(fqTobe, pkCol, colName, whereCond);
        Map<String, Object> sampleData = buildSampleData(tableLabel, colName, pkCol, samples, reason, stageLabel);
        quarantineService.record(
                ctx.getRunHistory().getId(),
                stage.getId(),
                binding.getId(),
                null,
                reason + " — " + colName,
                QuarantineSeverity.error,
                sampleData,
                count,
                ctx.getLogLineSeqCursor());
        ingest(ctx, "Audit " + reason + " in " + tableLabel + "." + colName + " (" + count + " rows)", false);
        rowFilters.add(whereCond);
        return 1;
    }

    private List<List<Object>> fetchSamples(String fqTable, String pkCol, String violatedCol,
                                            String whereCond) throws Exception {
        List<List<Object>> samples = new ArrayList<>();
        StringBuilder cols = new StringBuilder();
        if (pkCol != null) cols.append(quoteIdent(pkCol)).append(", ");
        cols.append(quoteIdent(violatedCol));
        String sql = "SELECT " + cols + " FROM " + fqTable
                + " WHERE " + whereCond + " LIMIT " + SAMPLE_LIMIT;
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

    private Map<String, Object> buildSampleData(String tobeTable, String violatedCol, String pkCol,
                                                List<List<Object>> samples, String reason, String stageLabel) {
        Map<String, Object> data = new HashMap<>();
        data.put("reason", reason);
        data.put("detail", tobeTable + "." + violatedCol + " — " + reason);
        data.put("severity", "error");
        data.put("stageLabel", stageLabel);
        /* table 필드는 사용자 화면용 — 호출부가 schema-qualified 이름 주입(가능 시). */
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

    /**
     * PK 중복(uniqueness) 검사 — tobe_ 데이터에서 TO-BE PK 컬럼 조합이 2회 이상 나오는지.
     * 위반 시 Quarantine(validate.pk_unique) + 1 반환. PK 컬럼 없으면 skip.
     * 위반 row 분리 정책: 중복 그룹의 모든 row 를 분리 대상으로 표시 (어느 row 가 "옳은" 지 알 수 없음).
     */
    private int checkPkUniqueness(StageContext ctx, StageInstance stage, MappingTableBinding binding,
                                  String fqTobe, String tableLabel, List<DdlColumn> cols,
                                  List<String> rowFilters) throws Exception {
        List<String> pkCols = cols.stream()
                .filter(c -> c.getPkOrder() != null)
                .sorted(Comparator.comparing(DdlColumn::getPkOrder))
                .map(DdlColumn::getPhysicalName)
                .toList();
        if (pkCols.isEmpty()) return 0;

        String pkList = String.join(", ", pkCols.stream().map(AuditStage::quoteIdent).toList());
        long dupGroups;
        try (Statement st = duckDbService.statement();
             ResultSet rs = st.executeQuery("SELECT COUNT(*) FROM (SELECT 1 FROM " + fqTobe
                     + " GROUP BY " + pkList + " HAVING COUNT(*) > 1) t")) {
            rs.next();
            dupGroups = rs.getLong(1);
        }
        if (dupGroups <= 0) return 0;

        List<List<Object>> samples = new ArrayList<>();
        try (Statement st = duckDbService.statement();
             ResultSet rs = st.executeQuery("SELECT " + pkList + ", COUNT(*) AS cnt FROM " + fqTobe
                     + " GROUP BY " + pkList + " HAVING COUNT(*) > 1 LIMIT " + SAMPLE_LIMIT)) {
            ResultSetMetaData md = rs.getMetaData();
            int cc = md.getColumnCount();
            while (rs.next()) {
                List<Object> row = new ArrayList<>(cc);
                for (int i = 1; i <= cc; i++) row.add(rs.getObject(i));
                samples.add(row);
            }
        }

        String pkNames = String.join(",", pkCols);
        Map<String, Object> data = new HashMap<>();
        data.put("reason", "PK duplicate");
        data.put("detail", tableLabel + " — duplicate PK (" + pkNames + ")");
        data.put("severity", "error");
        data.put("stageLabel", "validate.pk_unique");
        data.put("table", tableLabel);
        List<String> columns = new ArrayList<>(pkCols);
        columns.add("cnt");
        List<String> roles = new ArrayList<>();
        for (int i = 0; i < pkCols.size(); i++) roles.add("pk");
        roles.add("violated");
        data.put("columns", columns);
        data.put("columnRoles", roles);
        data.put("sampleRows", samples);

        quarantineService.record(ctx.getRunHistory().getId(), stage.getId(), binding.getId(), null,
                "PK duplicate — " + tableLabel, QuarantineSeverity.error, data, dupGroups,
                ctx.getLogLineSeqCursor());
        ingest(ctx, "Audit PK duplicate in " + tableLabel + " (" + dupGroups + " key group(s))", false);

        // 중복 PK 그룹에 속한 모든 row → 분리 대상. DuckDB 의 row tuple IN 비교 지원 활용.
        rowFilters.add("(" + pkList + ") IN (SELECT " + pkList + " FROM " + fqTobe
                + " GROUP BY " + pkList + " HAVING COUNT(*) > 1)");
        return 1;
    }

    /** 위반 row 일괄 삭제. WHERE 조건들의 OR union 을 DuckDB DELETE 로 실행, 삭제 row 수 반환. */
    private long deleteWhere(String fqTobe, String unionWhere) throws Exception {
        try (Statement st = duckDbService.statement()) {
            return st.executeLargeUpdate("DELETE FROM " + fqTobe + " WHERE " + unionWhere);
        }
    }

    /**
     * 위반 row 들을 parquet 으로 export. 경로: {output}/quarantine/{tobe_table}.parquet
     * 실패 시 (디렉터리 생성 실패, COPY 실패) null 반환 — quarantine 분리 자체는 중단 안 함
     * (sample 5행은 이미 QuarantineEntry 에 있고, 분리 + DELETE 는 정합성에 더 중요).
     */
    private Path exportViolationParquet(StageContext ctx, String fqTobe, String tobeTable, String unionWhere) {
        try {
            Path dir = ctx.getOutputDir().resolve("quarantine");
            Files.createDirectories(dir);
            Path out = dir.resolve(tobeTable + ".parquet");
            String escapedPath = out.toString().replace("\\", "/").replace("'", "''");
            String sql = "COPY (SELECT * FROM " + fqTobe + " WHERE " + unionWhere
                    + ") TO '" + escapedPath + "' (FORMAT PARQUET)";
            try (Statement st = duckDbService.statement()) {
                st.execute(sql);
            }
            return out;
        } catch (Exception e) {
            log.warn("Quarantine parquet export failed for {}: {}", tobeTable, e.getMessage());
            return null;
        }
    }

    /** dataType → DuckDB TRY_CAST 타입. char/varchar/text 등은 null (type 검사 skip). */
    private static String duckCastType(DdlColumn col) {
        String dt = col.getDataType() == null ? "" : col.getDataType().toLowerCase();
        if (dt.contains("int")) return "BIGINT";                       // tinyint/smallint/int/integer/bigint
        if (isNumericType(dt) || dt.contains("double")
                || dt.contains("real") || dt.contains("float")) return "DOUBLE";
        if (dt.contains("timestamp") || dt.contains("datetime")) return "TIMESTAMP";
        if (dt.contains("date")) return "DATE";
        return null;
    }

    private static boolean isNumeric(DdlColumn col) {
        return isNumericType(col.getDataType() == null ? "" : col.getDataType().toLowerCase());
    }

    private static boolean isNumericType(String dt) {
        return dt.contains("numeric") || dt.contains("decimal") || dt.contains("number");
    }

    /** length 체크 대상 = VARCHAR/CHAR/CLOB/TEXT 류 문자형만. TIMESTAMP(n)·NUMERIC(p,s) 의
     *  (n)/(p,s) 는 문자 길이가 아니므로 length 체크 skip. */
    private static boolean isStringType(String dataType) {
        if (dataType == null) return false;
        String t = dataType.toUpperCase().trim();
        return t.startsWith("VARCHAR") || t.startsWith("NVARCHAR")
                || t.startsWith("CHAR") || t.startsWith("NCHAR")
                || t.contains("CLOB") || t.equals("TEXT") || t.equals("LONG");
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

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
        // cutover 는 본운영 — 위반이 있으면 분리 없이 fail 시켜 downstream gate(LocalWorkerExecutor)에 맡긴다.
        // test / rehearsal 은 데이터 검증·시연 목적이므로 위반 row 를 DuckDB tobe_ 에서 분리해
        // Load 가 정상 row 만 적재하도록 한다 (PoC1 row-level Quarantine separation, sample 5행은
        // QuarantineService 가 이미 기록).
        boolean separateViolations = ctx.getRunHistory().getRunType() != RunType.cutover;

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

                /* 위반 row 분리용 WHERE 조건 모음 — 모든 검사가 추가, 마지막에 UNION (OR) 으로 DELETE. */
                List<String> rowFilters = new ArrayList<>();
                int violations = 0;
                for (DdlColumn col : cols) {
                    violations += auditColumn(ctx, stage, binding, fqTobe, tobeTable, pkCol, col, rowFilters);
                }
                // PK 중복(uniqueness) — 테이블 단위 검사
                violations += checkPkUniqueness(ctx, stage, binding, fqTobe, tobeTable, cols, rowFilters);

                long separated = 0;
                if (separateViolations && !rowFilters.isEmpty()) {
                    String unionWhere = "(" + String.join(") OR (", rowFilters) + ")";
                    separated = deleteWhere(fqTobe, unionWhere);
                    ingest(ctx, "Quarantine separated " + separated + " row(s) from " + tobeTable, true);
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
                        result.setErrorDetail(detail);
                    }
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

    /**
     * 한 컬럼에 적용 가능한 검사(NOT NULL / length / type / range)를 모두 수행.
     * 위반된 검사 종류 수를 반환 (각 위반은 Quarantine 1 row). rowFilters 에 위반 WHERE 조건 누적.
     */
    private int auditColumn(StageContext ctx, StageInstance stage, MappingTableBinding binding,
                            String fqTobe, String tobeTable, String pkCol, DdlColumn col,
                            List<String> rowFilters) throws Exception {
        int violations = 0;
        String colName = col.getPhysicalName();
        String q = quoteIdent(colName);

        // 1. NOT NULL
        if (!col.isNullable()) {
            violations += runCheck(ctx, stage, binding, fqTobe, tobeTable, pkCol, colName,
                    q + " IS NULL",
                    "NOT NULL violation", "validate.notnull", rowFilters);
        }
        // 2. length — 문자수 기준 (PG VARCHAR(n) = n 문자)
        Integer len = col.getLength();
        if (len != null && len > 0) {
            violations += runCheck(ctx, stage, binding, fqTobe, tobeTable, pkCol, colName,
                    "LENGTH(CAST(" + q + " AS VARCHAR)) > " + len + " AND " + q + " IS NOT NULL",
                    "Length > " + len, "validate.length", rowFilters);
        }
        // 3. type — 숫자/날짜/타임스탬프 컬럼인데 cast 실패 (빈 문자열 제외). char/varchar 는 skip.
        String castType = duckCastType(col);
        if (castType != null) {
            violations += runCheck(ctx, stage, binding, fqTobe, tobeTable, pkCol, colName,
                    "TRY_CAST(" + q + " AS " + castType + ") IS NULL AND " + q + " IS NOT NULL"
                            + " AND TRIM(CAST(" + q + " AS VARCHAR)) <> ''",
                    "Type cast failed (" + castType + ")", "validate.type", rowFilters);
        }
        // 4. range — 숫자지만 DECIMAL(p,s) 자릿수 초과 (정수부 overflow).
        if (isNumeric(col) && col.getPrecision() != null) {
            int p = col.getPrecision();
            int s = col.getScale() == null ? 0 : col.getScale();
            if (p > 0 && p <= 38 && s >= 0 && s <= p) {
                violations += runCheck(ctx, stage, binding, fqTobe, tobeTable, pkCol, colName,
                        "TRY_CAST(" + q + " AS DECIMAL(" + p + "," + s + ")) IS NULL"
                                + " AND TRY_CAST(" + q + " AS DOUBLE) IS NOT NULL",
                        "Numeric out of range DECIMAL(" + p + "," + s + ")", "validate.range", rowFilters);
            }
        }
        return violations;
    }

    /** 단일 검사 수행 — count > 0 이면 sample 추출 + Quarantine 기록 + 로그, 위반 시 1 반환.
     *  추가: rowFilters 에 위반 WHERE 조건 append (호출부가 unionWhere 만들어 DELETE 에 사용). */
    private int runCheck(StageContext ctx, StageInstance stage, MappingTableBinding binding,
                         String fqTobe, String tobeTable, String pkCol, String colName,
                         String whereCond, String reason, String stageLabel,
                         List<String> rowFilters) throws Exception {
        long count = countWhere(fqTobe, whereCond);
        if (count <= 0) return 0;
        List<List<Object>> samples = fetchSamples(fqTobe, pkCol, colName, whereCond);
        Map<String, Object> sampleData = buildSampleData(tobeTable, colName, pkCol, samples, reason, stageLabel);
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
        ingest(ctx, "Audit " + reason + " in " + tobeTable + "." + colName + " (" + count + " rows)", false);
        rowFilters.add(whereCond);
        return 1;
    }

    private long countWhere(String fqTable, String whereCond) throws Exception {
        try (Statement st = duckDbService.statement();
             ResultSet rs = st.executeQuery("SELECT COUNT(*) FROM " + fqTable + " WHERE " + whereCond)) {
            rs.next();
            return rs.getLong(1);
        }
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
                                  String fqTobe, String tobeTable, List<DdlColumn> cols,
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
        data.put("detail", tobeTable + " — duplicate PK (" + pkNames + ")");
        data.put("severity", "error");
        data.put("stageLabel", "validate.pk_unique");
        data.put("table", tobeTable);
        List<String> columns = new ArrayList<>(pkCols);
        columns.add("cnt");
        List<String> roles = new ArrayList<>();
        for (int i = 0; i < pkCols.size(); i++) roles.add("pk");
        roles.add("violated");
        data.put("columns", columns);
        data.put("columnRoles", roles);
        data.put("sampleRows", samples);

        quarantineService.record(ctx.getRunHistory().getId(), stage.getId(), binding.getId(), null,
                "PK duplicate — " + tobeTable, QuarantineSeverity.error, data, dupGroups,
                ctx.getLogLineSeqCursor());
        ingest(ctx, "Audit PK duplicate in " + tobeTable + " (" + dupGroups + " key group(s))", false);

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

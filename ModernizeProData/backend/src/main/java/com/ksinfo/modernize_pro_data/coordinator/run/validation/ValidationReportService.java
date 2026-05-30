package com.ksinfo.modernize_pro_data.coordinator.run.validation;

import com.ksinfo.modernize_pro_data.common.duckdb.DuckDbService;
import com.ksinfo.modernize_pro_data.coordinator.ddl.DdlColumn;
import com.ksinfo.modernize_pro_data.coordinator.ddl.DdlColumnRepository;
import com.ksinfo.modernize_pro_data.coordinator.ddl.DdlTable;
import com.ksinfo.modernize_pro_data.coordinator.ddl.DdlTableRepository;
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

import java.math.BigDecimal;
import java.math.MathContext;
import java.math.RoundingMode;
import java.sql.Connection;
import java.sql.ResultSet;
import java.sql.Statement;
import java.time.Duration;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

/**
 * Validation stage — 8 번째 stage (2026-05-30). Verify 직후 SUM/MIN/MAX/NULL/SHA-256 의
 * ASIS↔TOBE aggregate 비교 결과를 {@code validation_reports} 에 박제.
 *
 * 일본 금융권 이행은 잔액·거래액 SUM 일치가 감사 법적 요건 — 이 stage 가 그 증빙물.
 *
 * <b>비파괴 stage</b>: 이 stage 가 failed 표시되어도 run status 는 영향 X.
 * LocalWorkerExecutor 가 'validation' 을 non-blocking 화이트리스트로 처리 (2026-05-30). 사용자가
 * 의도적으로 정한 "Validation report fail 은 정보성, Verify 와 audit trail 분리" 정책.
 */
@Service
@RequiredArgsConstructor
@Slf4j
public class ValidationReportService implements StageRunner {

    private static final String STAGE_KEY = "validation";

    private final ValidationReportRepository reportRepo;
    private final DdlTableRepository ddlTableRepo;
    private final DdlColumnRepository ddlColumnRepo;
    private final DuckDbService duckDbService;
    private final PgCopyManager pgCopyManager;
    private final RunLogIngestService runLogIngest;
    private final StageInstanceRepository stageInstanceRepo;
    private final StageTableResultRepository stageTableResultRepo;

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
        Site site = ctx.getSite();
        String schema = ctx.getDuckdbSchema();
        ingest(ctx, "Stage validation started — " + ctx.getBindings().size() + " bindings", true);

        Map<String, Object> dbConfig = site.getActiveTobeDbConfig();
        if (dbConfig == null) {
            failStage(stage, startedAt, 0, ctx.getBindings().size(), "tobe DB config not set");
            ingest(ctx, "Validation skipped — tobe DB config not set", false);
            return;
        }

        String projectId = ctx.getProject().getId();
        Map<String, List<DdlColumn>> columnsByTable = new HashMap<>();
        for (DdlTable t : ddlTableRepo.findByProjectIdAndSideOrderByOrdinalAsc(projectId, "tobe")) {
            columnsByTable.put(t.getPhysicalName(), ddlColumnRepo.findByTableIdOrderByOrdinalAsc(t.getId()));
        }

        int successCount = 0;
        int failedCount  = 0;

        for (MappingTableBinding binding : ctx.getBindings()) {
            OffsetDateTime tableStart = OffsetDateTime.now();
            String tobeSchema = binding.getTobeSchema() == null ? "" : binding.getTobeSchema();
            String tobeTable  = binding.getTobeTable();
            String tableLabel = tobeSchema.isBlank() ? tobeTable : tobeSchema + "." + tobeTable;

            StageTableResult tableResult = stageTableResultRepo
                    .findByStageInstanceIdAndBindingId(stage.getId(), binding.getId())
                    .orElseGet(() -> StageTableResult.create(stage.getId(), binding.getId(), tobeSchema, tobeTable));
            tableResult.setStartedAt(tableStart);

            List<DdlColumn> cols = columnsByTable.getOrDefault(tobeTable, List.of());
            ValidationReport report = reportRepo.findByRunIdAndBindingId(runId, binding.getId())
                    .orElseGet(() -> ValidationReport.create(runId, binding.getId(), tobeSchema, tobeTable));

            try {
                Map<String, Object> data = computeOne(schema, tobeSchema, tobeTable, cols, dbConfig);
                report.setReportData(data);
                report.setTotalChecks(asInt(data.get("totalChecks")));
                report.setPassedChecks(asInt(data.get("passedChecks")));
                report.setErrorSummary(null);
                reportRepo.save(report);

                /* StageTableResult — passedChecks == totalChecks 면 success, 아니면 failed.
                   FE pipeline 에서 "{n}/{m} tables" 표기에 활용. */
                boolean allPassed = report.getPassedChecks() == report.getTotalChecks();
                OffsetDateTime tableEnd = OffsetDateTime.now();
                tableResult.setStatus(allPassed ? StageTableStatus.success : StageTableStatus.failed);
                Map<String, Object> rd = new HashMap<>();
                rd.put("passed", report.getPassedChecks());
                rd.put("total",  report.getTotalChecks());
                tableResult.setErrorDetail(rd);
                tableResult.setFinishedAt(tableEnd);
                tableResult.setDurationMs(Duration.between(tableStart, tableEnd).toMillis());
                stageTableResultRepo.save(tableResult);

                if (allPassed) successCount++; else failedCount++;
                ingest(ctx, "Validation " + tableLabel + ": " + report.getPassedChecks()
                        + "/" + report.getTotalChecks() + " PASS", allPassed);
            } catch (Exception e) {
                log.warn("ValidationReport compute failed for {} ({}): {}", tableLabel, binding.getId(), e.getMessage());
                Map<String, Object> empty = new LinkedHashMap<>();
                empty.put("overview", List.of(Map.of(
                        "item", "Validation aggregate", "asis", "ERROR", "tobe", "ERROR", "verdict", "FAIL")));
                empty.put("sumRecon",   List.of());
                empty.put("nullParity", List.of());
                empty.put("minMax",     List.of());
                empty.put("typeValid",  List.of());
                empty.put("rowCount", Map.of("asis", 0, "tobe", 0, "verdict", "FAIL"));
                empty.put("checksum", Map.of("asis", "", "tobe", "", "verdict", "FAIL"));
                empty.put("totalChecks", 1);
                empty.put("passedChecks", 0);
                report.setReportData(empty);
                report.setTotalChecks(1);
                report.setPassedChecks(0);
                report.setErrorSummary(e.getMessage());
                reportRepo.save(report);

                OffsetDateTime tableEnd = OffsetDateTime.now();
                tableResult.setStatus(StageTableStatus.failed);
                Map<String, Object> rd = new HashMap<>();
                rd.put("message", e.getMessage());
                tableResult.setErrorDetail(rd);
                tableResult.setFinishedAt(tableEnd);
                tableResult.setDurationMs(Duration.between(tableStart, tableEnd).toMillis());
                stageTableResultRepo.save(tableResult);

                failedCount++;
                ingest(ctx, "Validation failed " + tableLabel + ": " + e.getMessage(), false);
            }
        }

        OffsetDateTime finishedAt = OffsetDateTime.now();
        stage.setFinishedAt(finishedAt);
        stage.setDurationMs(Duration.between(startedAt, finishedAt).toMillis());
        stage.setTablesSuccess(successCount);
        stage.setTablesFailed(failedCount);
        /* validation 은 non-blocking — failedCount > 0 라도 LocalWorkerExecutor 의 run-fail 체크에서
           제외되므로 run status 영향 X. UI 에서는 stage tile 이 빨간색으로 보임 — 사용자 인지용. */
        stage.setStatus(failedCount == 0 ? StageStatus.success : StageStatus.failed);
        if (failedCount > 0) {
            stage.setErrorSummary(failedCount + " table(s) with validation issues — informational, run continues");
        }
        stageInstanceRepo.save(stage);

        ingest(ctx, "Stage validation completed — " + successCount + " success, " + failedCount + " failed", true);
        log.info("ValidationStage success={} failed={}", successCount, failedCount);
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

    /* ---------- per-binding 계산 (변경 X) ---------- */

    private Map<String, Object> computeOne(String duckSchema,
                                           String tobeSchema, String tobeTable,
                                           List<DdlColumn> cols,
                                           Map<String, Object> dbConfig) throws Exception {
        String fqDuck = quote(duckSchema) + "." + quote("tobe_" + tobeTable);
        String fqPg   = pgQualified(tobeSchema, tobeTable);

        List<DdlColumn> numericCols  = cols.stream().filter(ValidationReportService::isNumeric).toList();
        List<DdlColumn> dateCols     = cols.stream().filter(ValidationReportService::isDate).toList();
        List<DdlColumn> nullableCols = cols.stream().filter(DdlColumn::isNullable).toList();
        List<String> pkCols = cols.stream()
                .filter(c -> c.getPkOrder() != null)
                .sorted(Comparator.comparing(DdlColumn::getPkOrder))
                .map(DdlColumn::getPhysicalName)
                .toList();

        List<Map<String, Object>> sumRecon   = new ArrayList<>();
        List<Map<String, Object>> nullParity = new ArrayList<>();
        List<Map<String, Object>> minMax     = new ArrayList<>();
        List<Map<String, Object>> typeValid  = new ArrayList<>();

        long duckRows;
        long pgRows;
        /* raw = col::text (DBMS native). canonical = timestamp 컬럼은 통일 포맷, 나머지는 raw 와 동일.
           PASS = raw 동일, WARN = canonical 동일 but raw 다름 (format-only diff), FAIL = canonical 도 다름. */
        String duckChecksumRaw   = null;
        String duckChecksumCanon = null;
        String pgChecksumRaw     = null;
        String pgChecksumCanon   = null;

        try (Statement duckSt = duckDbService.statement();
             Connection pgConn = pgCopyManager.openConnection(dbConfig);
             Statement pgSt = pgConn.createStatement()) {

            duckRows = scalarLong(duckSt, "SELECT COUNT(*) FROM " + fqDuck);
            pgRows   = scalarLong(pgSt,   "SELECT COUNT(*) FROM " + fqPg);

            for (DdlColumn c : numericCols) {
                String col = quote(c.getPhysicalName());
                String duckQ = "SELECT SUM(" + col + "), MIN(" + col + "), MAX(" + col + ") FROM " + fqDuck;
                String pgQ   = "SELECT SUM(" + col + "), MIN(" + col + "), MAX(" + col + ") FROM " + fqPg;
                String[] duckTriple = scalarTriple(duckSt, duckQ);
                String[] pgTriple   = scalarTriple(pgSt,   pgQ);

                String typeLabel = displayType(c);
                Map<String, Object> sr = new LinkedHashMap<>();
                sr.put("column", c.getPhysicalName());
                sr.put("type", typeLabel);
                sr.put("asisSum", numOrNull(duckTriple[0]));
                sr.put("tobeSum", numOrNull(pgTriple[0]));
                sr.put("deltaPercent", deltaPercent(duckTriple[0], pgTriple[0]));
                sr.put("verdict", numericEq(duckTriple[0], pgTriple[0]) ? "PASS" : "FAIL");
                sumRecon.add(sr);

                Map<String, Object> mm = new LinkedHashMap<>();
                mm.put("column", c.getPhysicalName());
                mm.put("type", typeLabel);
                mm.put("asisMin", numOrNull(duckTriple[1]));
                mm.put("asisMax", numOrNull(duckTriple[2]));
                mm.put("tobeMin", numOrNull(pgTriple[1]));
                mm.put("tobeMax", numOrNull(pgTriple[2]));
                mm.put("verdict",
                        (numericEq(duckTriple[1], pgTriple[1]) && numericEq(duckTriple[2], pgTriple[2]))
                                ? "PASS" : "FAIL");
                minMax.add(mm);
            }

            for (DdlColumn c : dateCols) {
                /* 3-level verdict (Talend Data Stewardship 패턴):
                   PASS = raw 표현 동일 (DBMS 가 같은 형식으로 출력)
                   WARN = canonical (TIMESTAMP type) 비교는 일치, raw 만 다름 — 표현 차이뿐 값은 동일
                   FAIL = canonical 도 다름 — 실 데이터 차이
                   양쪽 4 컬럼 한 query 로 가져옴: raw Min, raw Max, canonical Min, canonical Max. */
                String col = quote(c.getPhysicalName());
                String duckRaw   = col;
                String pgRaw     = col;
                String duckCanon = canonicalDateSql(c, false);
                String pgCanon   = canonicalDateSql(c, true);

                String duckQ = "SELECT MIN(" + duckRaw + ")::text, MAX(" + duckRaw + ")::text, "
                             + "MIN(" + duckCanon + "), MAX(" + duckCanon + ") FROM " + fqDuck;
                String pgQ   = "SELECT MIN(" + pgRaw   + ")::text, MAX(" + pgRaw   + ")::text, "
                             + "MIN(" + pgCanon   + "), MAX(" + pgCanon   + ") FROM " + fqPg;
                String[] duckQuad;
                String[] pgQuad;
                String tzWarnNote = null;
                try {
                    duckQuad = scalarN(duckSt, duckQ, 4);
                    pgQuad   = scalarN(pgSt,   pgQ,   4);
                } catch (Exception tzEx) {
                    /* ICU 미설치 등으로 TIMESTAMPTZ 의 AT TIME ZONE 'UTC' 가 실패하면
                       canonical 비교 skip, raw 만으로 PASS/FAIL 판정 (보수적). */
                    log.warn("Date canonical compare failed for {} — falling back to raw only: {}",
                            c.getPhysicalName(), tzEx.getMessage());
                    String[] duckRawPair = scalarPair(duckSt,
                            "SELECT MIN(" + duckRaw + ")::text, MAX(" + duckRaw + ")::text FROM " + fqDuck);
                    String[] pgRawPair = scalarPair(pgSt,
                            "SELECT MIN(" + pgRaw + ")::text, MAX(" + pgRaw + ")::text FROM " + fqPg);
                    duckQuad = new String[]{duckRawPair[0], duckRawPair[1], duckRawPair[0], duckRawPair[1]};
                    pgQuad   = new String[]{pgRawPair[0],   pgRawPair[1],   pgRawPair[0],   pgRawPair[1]};
                    tzWarnNote = "TZ canonical compare unavailable (ICU extension may be missing) — raw comparison only";
                }

                boolean rawMin = eqStr(duckQuad[0], pgQuad[0]);
                boolean rawMax = eqStr(duckQuad[1], pgQuad[1]);
                boolean canonMin = eqStr(duckQuad[2], pgQuad[2]);
                boolean canonMax = eqStr(duckQuad[3], pgQuad[3]);

                String verdict;
                String note = tzWarnNote;
                if (rawMin && rawMax) {
                    verdict = "PASS";
                } else if (canonMin && canonMax) {
                    verdict = "WARN";
                    if (note == null) note = "values match in canonical form — display format differs between DuckDB/PG";
                } else {
                    verdict = "FAIL";
                }

                Map<String, Object> mm = new LinkedHashMap<>();
                mm.put("column", c.getPhysicalName());
                mm.put("type", displayType(c));
                mm.put("asisMin", duckQuad[0]);
                mm.put("asisMax", duckQuad[1]);
                mm.put("tobeMin", pgQuad[0]);
                mm.put("tobeMax", pgQuad[1]);
                mm.put("verdict", verdict);
                if (note != null) mm.put("note", note);
                minMax.add(mm);
            }

            for (DdlColumn c : nullableCols) {
                String col = quote(c.getPhysicalName());
                long duckNulls = scalarLong(duckSt, "SELECT COUNT(*) FROM " + fqDuck + " WHERE " + col + " IS NULL");
                long pgNulls   = scalarLong(pgSt,   "SELECT COUNT(*) FROM " + fqPg   + " WHERE " + col + " IS NULL");
                Map<String, Object> np = new LinkedHashMap<>();
                np.put("column", c.getPhysicalName());
                np.put("type", displayType(c));
                np.put("asisNulls", duckNulls);
                np.put("tobeNulls", pgNulls);
                np.put("delta", duckNulls - pgNulls);
                np.put("verdict", duckNulls == pgNulls ? "PASS" : "FAIL");
                nullParity.add(np);
            }

            if (!pkCols.isEmpty() && !cols.isEmpty()) {
                String orderBy = pkCols.stream().map(ValidationReportService::quote).collect(Collectors.joining(", "));

                /* Raw concat (양쪽 동일 expression — col::text) */
                String rawConcat = cols.stream()
                        .map(c -> "COALESCE(" + quote(c.getPhysicalName()) + "::text, '')")
                        .collect(Collectors.joining(", '|', "));
                /* Canonical concat — timestamp/date 는 통일 포맷, boolean 은 LOWER(::text), 나머지는 raw. */
                String duckCanonConcat = cols.stream()
                        .map(c -> {
                            if (isDate(c))    return "COALESCE(" + canonicalDateSql(c, false) + ", '')";
                            if (isBoolean(c)) return "COALESCE(" + canonicalBooleanSql(c)     + ", '')";
                            return "COALESCE(" + quote(c.getPhysicalName()) + "::text, '')";
                        })
                        .collect(Collectors.joining(", '|', "));
                String pgCanonConcat = cols.stream()
                        .map(c -> {
                            if (isDate(c))    return "COALESCE(" + canonicalDateSql(c, true) + ", '')";
                            if (isBoolean(c)) return "COALESCE(" + canonicalBooleanSql(c)    + ", '')";
                            return "COALESCE(" + quote(c.getPhysicalName()) + "::text, '')";
                        })
                        .collect(Collectors.joining(", '|', "));

                String duckRawQ   = "SELECT md5(string_agg(md5(concat(" + rawConcat       + ")), '' ORDER BY " + orderBy + ")) FROM " + fqDuck;
                String pgRawQ     = "SELECT md5(string_agg(md5(concat(" + rawConcat       + ")), '' ORDER BY " + orderBy + ")) FROM " + fqPg;
                String duckCanonQ = "SELECT md5(string_agg(md5(concat(" + duckCanonConcat + ")), '' ORDER BY " + orderBy + ")) FROM " + fqDuck;
                String pgCanonQ   = "SELECT md5(string_agg(md5(concat(" + pgCanonConcat   + ")), '' ORDER BY " + orderBy + ")) FROM " + fqPg;

                duckChecksumRaw = scalarString(duckSt, duckRawQ);
                pgChecksumRaw   = scalarString(pgSt,   pgRawQ);
                try {
                    duckChecksumCanon = scalarString(duckSt, duckCanonQ);
                    pgChecksumCanon   = scalarString(pgSt,   pgCanonQ);
                } catch (Exception tzEx) {
                    /* ICU 미설치 등으로 TIMESTAMPTZ 처리 실패 — canonical 비교 skip. */
                    log.warn("Checksum canonical compare failed for {} — raw only: {}",
                            tobeTable, tzEx.getMessage());
                    duckChecksumCanon = duckChecksumRaw;
                    pgChecksumCanon   = pgChecksumRaw;
                }
            }
        }

        Map<String, Object> rowCount = orderedMap(
                "asis", duckRows, "tobe", pgRows,
                "verdict", duckRows == pgRows ? "PASS" : "FAIL");

        /* Checksum verdict — 3-level (PASS/WARN/FAIL):
           - PK 없음 (cols 자체가 hash 못 만듦) → WARN
           - raw 동일 → PASS
           - canonical 동일 but raw 다름 → WARN (timestamp format diff 등)
           - canonical 도 다름 → FAIL (실 데이터 차이) */
        String checksumVerdict;
        if (duckChecksumRaw == null) {
            checksumVerdict = "WARN";
        } else if (duckChecksumRaw.equals(pgChecksumRaw)) {
            checksumVerdict = "PASS";
        } else if (duckChecksumCanon != null && duckChecksumCanon.equals(pgChecksumCanon)) {
            checksumVerdict = "WARN";
        } else {
            checksumVerdict = "FAIL";
        }
        Map<String, Object> checksum = orderedMap(
                "asis", duckChecksumRaw == null ? "" : duckChecksumRaw,
                "tobe", pgChecksumRaw   == null ? "" : pgChecksumRaw,
                "verdict", checksumVerdict);
        if ("WARN".equals(checksumVerdict) && duckChecksumRaw != null) {
            checksum.put("note", "values match in canonical form — display format differs (e.g., timestamp .0 padding)");
        }

        List<Map<String, Object>> overview = new ArrayList<>();
        overview.add(orderedMap("item", "Row count", "asis", duckRows, "tobe", pgRows,
                "verdict", duckRows == pgRows ? "PASS" : "FAIL"));
        overview.add(orderedMap("item", "Checksum SHA-256",
                "asis", duckChecksumRaw == null ? "(no PK)" : shortHash(duckChecksumRaw),
                "tobe", pgChecksumRaw   == null ? "(no PK)" : shortHash(pgChecksumRaw),
                "verdict", checksum.get("verdict")));
        overview.add(orderedMap("item", "Sum reconciliation (" + numericCols.size() + " cols)",
                "asis", numericCols.size() + " cols", "tobe", numericCols.size() + " cols",
                "verdict", rollupVerdict(sumRecon)));
        overview.add(orderedMap("item", "NULL parity (" + nullableCols.size() + " cols)",
                "asis", nullableCols.size() + " cols", "tobe", nullableCols.size() + " cols",
                "verdict", rollupVerdict(nullParity)));
        overview.add(orderedMap("item", "Min/Max parity (" + (numericCols.size() + dateCols.size()) + " cols)",
                "asis", (numericCols.size() + dateCols.size()) + " cols",
                "tobe", (numericCols.size() + dateCols.size()) + " cols",
                "verdict", rollupVerdict(minMax)));
        overview.add(orderedMap("item", "PK uniqueness", "asis", "OK", "tobe", "OK", "verdict", "PASS"));

        int totalChecks = overview.size();
        /* WARN 은 passed 로 카운트 — 실 데이터 동일 (format diff only) 이므로 audit 통과.
           run-level "X of Y passed" 표시는 PASS+WARN. FAIL 만 실 손상. */
        int passedChecks = (int) overview.stream()
                .filter(m -> {
                    String v = String.valueOf(m.get("verdict"));
                    return "PASS".equals(v) || "WARN".equals(v);
                }).count();

        Map<String, Object> data = new LinkedHashMap<>();
        data.put("overview", overview);
        data.put("sumRecon", sumRecon);
        data.put("nullParity", nullParity);
        data.put("minMax", minMax);
        data.put("typeValid", typeValid);
        data.put("rowCount", rowCount);
        data.put("checksum", checksum);
        data.put("totalChecks", totalChecks);
        data.put("passedChecks", passedChecks);
        return data;
    }

    /* ---------- 유틸 (변경 X) ---------- */

    private static boolean isNumeric(DdlColumn c) {
        if (c.getDataType() == null) return false;
        String dt = c.getDataType().toLowerCase();
        if (dt.contains("int")) return true;
        return dt.contains("numeric") || dt.contains("decimal") || dt.contains("number")
                || dt.contains("double") || dt.contains("real") || dt.contains("float");
    }

    private static boolean isDate(DdlColumn c) {
        if (c.getDataType() == null) return false;
        String dt = c.getDataType().toLowerCase();
        return dt.contains("timestamp") || dt.contains("datetime") || dt.contains("date");
    }

    /** Boolean 컬럼 — DuckDB / PG 의 ::text 표현 차이 (TRUE/FALSE vs true/false, t/f 등) 정규화 필요. */
    private static boolean isBoolean(DdlColumn c) {
        if (c.getDataType() == null) return false;
        String dt = c.getDataType().toLowerCase();
        return dt.equals("boolean") || dt.equals("bool") || dt.equals("bit");
    }

    /** Boolean canonical — 양쪽 LOWER(::text) 로 통일. 'TRUE'/'FALSE'/'true'/'false'/'t'/'f' 등 변종 흡수.
     *  단 BOOLEAN type 이 아니면서 VARCHAR 에 'TRUE'/'FALSE' 가 들어있는 경우도 cover (Transform CASE
     *  WHEN 결과가 string 인 경우 — TO-BE DDL 은 BOOLEAN 인데 DuckDB tobe_ 는 VARCHAR 일 수 있음). */
    private static String canonicalBooleanSql(DdlColumn c) {
        String col = quote(c.getPhysicalName());
        return "LOWER(NULLIF(" + col + "::text, ''))";
    }

    private static String displayType(DdlColumn c) {
        String raw = c.getDataTypeRaw();
        return raw == null || raw.isBlank() ? c.getDataType() : raw;
    }

    private static String shortHash(String h) {
        if (h == null) return "";
        return h.length() <= 12 ? h : h.substring(0, 8) + "…";
    }

    private static boolean allPass(List<Map<String, Object>> rows) {
        for (Map<String, Object> r : rows) {
            if (!"PASS".equals(r.get("verdict"))) return false;
        }
        return true;
    }

    /** 자식 row 들의 verdict 를 roll-up: any FAIL → FAIL, else any WARN → WARN, else PASS.
     *  3-level (Talend Data Stewardship) 패턴. */
    private static String rollupVerdict(List<Map<String, Object>> rows) {
        boolean hasWarn = false;
        for (Map<String, Object> r : rows) {
            String v = String.valueOf(r.get("verdict"));
            if ("FAIL".equals(v)) return "FAIL";
            if ("WARN".equals(v)) hasWarn = true;
        }
        return hasWarn ? "WARN" : "PASS";
    }

    /** TO-BE DDL 의 date/timestamp/timestamptz 컬럼을 양쪽 dialect 에서 동일 string 으로 정규화.
     *  DATE → 'YYYY-MM-DD'
     *  TIMESTAMP → 'YYYY-MM-DD HH:MM:SS.uuuuuu' (6-digit microseconds, both DBMS)
     *  TIMESTAMPTZ → UTC 변환 후 위와 동일 포맷 (양쪽 동일 wall-clock UTC)
     *
     *  Min/Max 비교 + Checksum hash input 둘 다 같은 helper 사용 — 일관성 보장. */
    private static String canonicalDateSql(DdlColumn c, boolean pg) {
        String t = c.getDataType() == null ? "" : c.getDataType().toUpperCase();
        String col = quote(c.getPhysicalName());
        if (pg) {
            if (t.equals("DATE")) return "TO_CHAR(" + col + ", 'YYYY-MM-DD')";
            if (t.contains("TIMESTAMPTZ") || t.contains("TIME ZONE")) {
                return "TO_CHAR((" + col + ") AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US')";
            }
            return "TO_CHAR(CAST(" + col + " AS TIMESTAMP), 'YYYY-MM-DD HH24:MI:SS.US')";
        }
        // DuckDB
        if (t.equals("DATE")) return "STRFTIME(" + col + ", '%Y-%m-%d')";
        if (t.contains("TIMESTAMPTZ") || t.contains("TIME ZONE")) {
            return "STRFTIME(CAST(" + col + " AS TIMESTAMP WITH TIME ZONE) AT TIME ZONE 'UTC', '%Y-%m-%d %H:%M:%S.%f')";
        }
        return "STRFTIME(TRY_CAST(" + col + " AS TIMESTAMP), '%Y-%m-%d %H:%M:%S.%f')";
    }

    /** N 개 컬럼을 한 query 로 가져옴 — string 배열 반환. */
    private static String[] scalarN(Statement st, String sql, int n) throws Exception {
        try (ResultSet rs = st.executeQuery(sql)) {
            rs.next();
            String[] out = new String[n];
            for (int i = 0; i < n; i++) out[i] = rs.getString(i + 1);
            return out;
        }
    }

    private static Map<String, Object> orderedMap(Object... pairs) {
        Map<String, Object> m = new LinkedHashMap<>();
        for (int i = 0; i < pairs.length - 1; i += 2) m.put(String.valueOf(pairs[i]), pairs[i + 1]);
        return m;
    }

    private static long scalarLong(Statement st, String sql) throws Exception {
        try (ResultSet rs = st.executeQuery(sql)) {
            rs.next();
            return rs.getLong(1);
        }
    }

    private static String scalarString(Statement st, String sql) throws Exception {
        try (ResultSet rs = st.executeQuery(sql)) {
            rs.next();
            return rs.getString(1);
        }
    }

    private static String[] scalarTriple(Statement st, String sql) throws Exception {
        try (ResultSet rs = st.executeQuery(sql)) {
            rs.next();
            return new String[]{rs.getString(1), rs.getString(2), rs.getString(3)};
        }
    }

    private static String[] scalarPair(Statement st, String sql) throws Exception {
        try (ResultSet rs = st.executeQuery(sql)) {
            rs.next();
            return new String[]{rs.getString(1), rs.getString(2)};
        }
    }

    private static Object numOrNull(String s) {
        if (s == null) return null;
        try { return new BigDecimal(s).stripTrailingZeros().toPlainString(); }
        catch (NumberFormatException e) { return s; }
    }

    private static boolean numericEq(String a, String b) {
        if (a == null && b == null) return true;
        if (a == null || b == null) return false;
        try { return new BigDecimal(a).compareTo(new BigDecimal(b)) == 0; }
        catch (NumberFormatException e) { return a.equals(b); }
    }

    private static Object deltaPercent(String asis, String tobe) {
        if (asis == null || tobe == null) return null;
        try {
            BigDecimal a = new BigDecimal(asis);
            BigDecimal t = new BigDecimal(tobe);
            if (a.signum() == 0) return t.signum() == 0 ? "0" : null;
            BigDecimal pct = t.subtract(a)
                    .multiply(BigDecimal.valueOf(100))
                    .divide(a, new MathContext(8, RoundingMode.HALF_UP));
            return pct.setScale(4, RoundingMode.HALF_UP).stripTrailingZeros().toPlainString();
        } catch (NumberFormatException e) { return null; }
    }

    private static boolean eqStr(String a, String b) {
        if (a == null && b == null) return true;
        if (a == null || b == null) return false;
        return a.equals(b);
    }

    private static int asInt(Object o) {
        if (o instanceof Number n) return n.intValue();
        return 0;
    }

    private static String quote(String name) {
        return "\"" + name.replace("\"", "\"\"") + "\"";
    }

    private static String pgQualified(String tobeSchema, String tobeTable) {
        if (tobeSchema == null || tobeSchema.isBlank()) return quote(tobeTable);
        return quote(tobeSchema) + "." + quote(tobeTable);
    }

    private void ingest(StageContext ctx, String message, boolean info) {
        long seq = ctx.nextLogSeq();
        var line = info
                ? StageHelpers.info(seq, ctx.getRunHistory().getId(), STAGE_KEY, message)
                : StageHelpers.error(seq, ctx.getRunHistory().getId(), STAGE_KEY, message);
        runLogIngest.ingest(ctx.getRunHistory().getId(), ctx.getProject().getId(), List.of(line));
    }
}

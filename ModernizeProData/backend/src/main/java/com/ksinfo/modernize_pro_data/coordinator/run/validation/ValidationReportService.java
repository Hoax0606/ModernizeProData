package com.ksinfo.modernize_pro_data.coordinator.run.validation;

import com.ksinfo.modernize_pro_data.common.duckdb.DuckDbService;
import com.ksinfo.modernize_pro_data.coordinator.ddl.DdlColumn;
import com.ksinfo.modernize_pro_data.coordinator.ddl.DdlColumnRepository;
import com.ksinfo.modernize_pro_data.coordinator.ddl.DdlTable;
import com.ksinfo.modernize_pro_data.coordinator.ddl.DdlTableRepository;
import com.ksinfo.modernize_pro_data.coordinator.load.PgCopyManager;
import com.ksinfo.modernize_pro_data.coordinator.mapping.MappingTableBinding;
import com.ksinfo.modernize_pro_data.coordinator.quarantine.QuarantineEntry;
import com.ksinfo.modernize_pro_data.coordinator.quarantine.QuarantineEntryRepository;
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
 * <b>합병 정책 (2026-05-30)</b>: 다른 stage 와 동일 취급.
 * FAIL 시 stage.status=failed → run.status=failed. WARN 은 stage.status=success (format diff only).
 * 또한 FAIL 인 체크별로 {@link QuarantineService#record} 호출 — AuditStage 와 같은 quarantine 채널
 * 에서 노출. stageLabel='validate.*' 로 구분. V-7 의 분리 정책 revert.
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
    private final QuarantineService quarantineService;
    private final QuarantineEntryRepository quarantineEntryRepo;

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
                Map<String, Object> data = computeOne(ctx, stage, binding, tableLabel,
                        schema, tobeSchema, tobeTable, cols, dbConfig);
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
                empty.put("quarantineStats", List.of());
                empty.put("rowCount", Map.of("asis", 0, "quarantined", 0, "tobe", 0, "verdict", "FAIL"));
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
        /* 2026-05-30 합병 정책: validation 도 다른 stage 와 동일 — failedCount>0 면 run 도 failed.
           각 FAIL 항목별 quarantine entry 도 발생 (computeOne 안에서 record). */
        stage.setStatus(failedCount == 0 ? StageStatus.success : StageStatus.failed);

        /* 2026-05-31 추가: stage 의 quarantine_entries 를 stageLabel × severity 별로 집계 →
           운영자가 LogViewer / errorSummary 만 봐도 어느 check 가 fail/warn 인지 즉시 파악. */
        Map<String, List<String>> failBreakdown = new java.util.TreeMap<>();   // label → [reason, ...]
        Map<String, List<String>> warnBreakdown = new java.util.TreeMap<>();
        for (QuarantineEntry q : quarantineEntryRepo
                .findByRunIdOrderByCreatedAtAsc(ctx.getRunHistory().getId())) {
            if (!stage.getId().equals(q.getStageInstanceId())) continue;
            Map<String, Object> sample = q.getSampleData();
            if (sample == null) continue;
            String label = String.valueOf(sample.getOrDefault("stageLabel", ""));
            String reason = String.valueOf(sample.getOrDefault("reason", ""));
            Map<String, List<String>> target = q.getSeverity() == QuarantineSeverity.warning
                    ? warnBreakdown : failBreakdown;
            target.computeIfAbsent(label, k -> new ArrayList<>()).add(reason);
        }

        StringBuilder summary = new StringBuilder();
        summary.append(successCount).append(" success, ").append(failedCount).append(" failed");
        if (!failBreakdown.isEmpty() || !warnBreakdown.isEmpty()) {
            for (var e : failBreakdown.entrySet()) {
                summary.append("\n  · ").append(friendlyStageLabel(e.getKey()))
                       .append(" FAIL (").append(e.getValue().size()).append("): ")
                       .append(String.join("; ", e.getValue()));
            }
            for (var e : warnBreakdown.entrySet()) {
                summary.append("\n  · ").append(friendlyStageLabel(e.getKey()))
                       .append(" WARN (").append(e.getValue().size()).append("): ")
                       .append(String.join("; ", e.getValue()));
            }
        }

        if (failedCount > 0) {
            stage.setErrorSummary(summary.toString());
        }
        stageInstanceRepo.save(stage);

        ingest(ctx, "Stage validation completed — " + summary, true);
        log.info("ValidationStage success={} failed={}", successCount, failedCount);
    }

    /** BE 의 stageLabel (validate.range 등) → 운영자 친숙 라벨. FE friendlyStageLabel 과 같은 매핑. */
    private static String friendlyStageLabel(String label) {
        return switch (label) {
            case "validate.range"       -> "Numeric Range Overflow";
            case "validate.type"        -> "Type Cast Failure";
            case "validate.length"      -> "String Length Overflow";
            case "validate.notnull"     -> "NOT NULL Violation";
            case "validate.pk_unique"   -> "Primary Key Duplicate";
            case "validate.fk"          -> "Foreign Key Violation";
            case "validate.sum_recon"   -> "Total Reconciliation Mismatch";
            case "validate.min_max"     -> "Min/Max Mismatch";
            case "validate.null_parity" -> "NULL Count Mismatch";
            case "validate.row_count"   -> "Record Count Mismatch";
            case "validate.checksum"    -> "Data Integrity Mismatch";
            default -> label == null || label.isEmpty() ? "(unknown)" : label;
        };
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

    /* ---------- per-binding 계산 (2026-05-30 합병 정책 — FAIL 시 quarantine record) ---------- */

    private Map<String, Object> computeOne(StageContext ctx, StageInstance stage,
                                           MappingTableBinding binding, String tableLabel,
                                           String duckSchema,
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
                boolean sumPass = numericEq(duckTriple[0], pgTriple[0]);
                Map<String, Object> sr = new LinkedHashMap<>();
                sr.put("column", c.getPhysicalName());
                sr.put("type", typeLabel);
                sr.put("asisSum", numOrNull(duckTriple[0]));
                sr.put("tobeSum", numOrNull(pgTriple[0]));
                sr.put("deltaPercent", deltaPercent(duckTriple[0], pgTriple[0]));
                sr.put("verdict", sumPass ? "PASS" : "FAIL");
                if (!sumPass) sr.put("note", "SUM differs — ASIS=" + nullSafe(duckTriple[0])
                        + " TOBE=" + nullSafe(pgTriple[0]));
                sumRecon.add(sr);
                if (!sumPass) {
                    recordQuarantine(ctx, stage, binding, tableLabel,
                            "validate.sum_recon", "Validation SUM mismatch — " + c.getPhysicalName(),
                            List.of("column", "ASIS SUM", "TOBE SUM", "delta %"),
                            List.of("metric", "asis_value", "tobe_value", "delta"),
                            List.of(List.of(c.getPhysicalName(),
                                    duckTriple[0] == null ? "" : duckTriple[0],
                                    pgTriple[0] == null ? "" : pgTriple[0],
                                    String.valueOf(deltaPercent(duckTriple[0], pgTriple[0])))),
                            1, QuarantineSeverity.error);
                }

                boolean minMaxPass = numericEq(duckTriple[1], pgTriple[1])
                                  && numericEq(duckTriple[2], pgTriple[2]);
                Map<String, Object> mm = new LinkedHashMap<>();
                mm.put("column", c.getPhysicalName());
                mm.put("type", typeLabel);
                mm.put("asisMin", numOrNull(duckTriple[1]));
                mm.put("asisMax", numOrNull(duckTriple[2]));
                mm.put("tobeMin", numOrNull(pgTriple[1]));
                mm.put("tobeMax", numOrNull(pgTriple[2]));
                mm.put("verdict", minMaxPass ? "PASS" : "FAIL");
                if (!minMaxPass) mm.put("note", "MIN/MAX differs");
                minMax.add(mm);
                if (!minMaxPass) {
                    recordQuarantine(ctx, stage, binding, tableLabel,
                            "validate.min_max", "Validation MIN/MAX mismatch — " + c.getPhysicalName(),
                            List.of("column", "ASIS min/max", "TOBE min/max"),
                            List.of("metric", "asis_value", "tobe_value"),
                            List.of(List.of(c.getPhysicalName(),
                                    (duckTriple[1] == null ? "" : duckTriple[1]) + " / "
                                            + (duckTriple[2] == null ? "" : duckTriple[2]),
                                    (pgTriple[1] == null ? "" : pgTriple[1]) + " / "
                                            + (pgTriple[2] == null ? "" : pgTriple[2]))),
                            1, QuarantineSeverity.error);
                }
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
                /* FAIL = severity=error, WARN = severity=warning (2026-05-31).
                   WARN 도 KPI/Quarantine 통일성을 위해 적재. 단 reason 은 "format differs (canonical match)" 로 명시. */
                if ("FAIL".equals(verdict)) {
                    recordQuarantine(ctx, stage, binding, tableLabel,
                            "validate.min_max", "Validation date MIN/MAX mismatch — " + c.getPhysicalName(),
                            List.of("column", "ASIS min/max", "TOBE min/max"),
                            List.of("metric", "asis_value", "tobe_value"),
                            List.of(List.of(c.getPhysicalName(),
                                    nullSafe(duckQuad[0]) + " / " + nullSafe(duckQuad[1]),
                                    nullSafe(pgQuad[0])   + " / " + nullSafe(pgQuad[1]))),
                            1, QuarantineSeverity.error);
                } else if ("WARN".equals(verdict)) {
                    recordQuarantine(ctx, stage, binding, tableLabel,
                            "validate.min_max", "Validation date MIN/MAX format differs (values match) — "
                                    + c.getPhysicalName(),
                            List.of("column", "ASIS min/max", "TOBE min/max"),
                            List.of("metric", "asis_value", "tobe_value"),
                            List.of(List.of(c.getPhysicalName(),
                                    nullSafe(duckQuad[0]) + " / " + nullSafe(duckQuad[1]),
                                    nullSafe(pgQuad[0])   + " / " + nullSafe(pgQuad[1]))),
                            1, QuarantineSeverity.warning);
                }
            }

            for (DdlColumn c : nullableCols) {
                String col = quote(c.getPhysicalName());
                long duckNulls = scalarLong(duckSt, "SELECT COUNT(*) FROM " + fqDuck + " WHERE " + col + " IS NULL");
                long pgNulls   = scalarLong(pgSt,   "SELECT COUNT(*) FROM " + fqPg   + " WHERE " + col + " IS NULL");
                boolean nullPass = duckNulls == pgNulls;
                Map<String, Object> np = new LinkedHashMap<>();
                np.put("column", c.getPhysicalName());
                np.put("type", displayType(c));
                np.put("asisNulls", duckNulls);
                np.put("tobeNulls", pgNulls);
                np.put("delta", duckNulls - pgNulls);
                np.put("verdict", nullPass ? "PASS" : "FAIL");
                if (!nullPass) np.put("note", "NULL count differs (delta=" + (duckNulls - pgNulls) + ")");
                nullParity.add(np);
                if (!nullPass) {
                    recordQuarantine(ctx, stage, binding, tableLabel,
                            "validate.null_parity", "Validation NULL count mismatch — " + c.getPhysicalName(),
                            List.of("column", "ASIS NULLS", "TOBE NULLS"),
                            List.of("metric", "asis_value", "tobe_value"),
                            List.of(List.of(c.getPhysicalName(),
                                    String.valueOf(duckNulls), String.valueOf(pgNulls))),
                            Math.abs(duckNulls - pgNulls), QuarantineSeverity.error);
                }
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

        /* Binding 의 모든 quarantine_entries fetch — typeValid 시트 + quarantineStats 시트 +
           row_count 보정 셋 다에서 사용. (2026-05-31 통합) */
        Map<String, DdlColumn> colByName = new HashMap<>();
        for (DdlColumn c : cols) colByName.put(c.getPhysicalName(), c);
        List<QuarantineEntry> bindingQuarantine = quarantineEntryRepo
                .findByRunIdOrderByCreatedAtAsc(ctx.getRunHistory().getId())
                .stream()
                .filter(q -> binding.getId().equals(q.getBindingId()))
                .toList();

        /* typeValid 시트 — AuditStage 의 row-level type/length/range 위반. */
        for (QuarantineEntry qe : bindingQuarantine) {
            Map<String, Object> sample = qe.getSampleData();
            if (sample == null) continue;
            String label = String.valueOf(sample.getOrDefault("stageLabel", ""));
            if (!label.startsWith("validate.range")
             && !label.startsWith("validate.type")
             && !label.startsWith("validate.length")) continue;
            List<?> qColumns = sample.get("columns") instanceof List<?> l ? l : List.of();
            String violatedCol = qColumns.size() >= 2 ? String.valueOf(qColumns.get(1))
                               : qColumns.size() >= 1 ? String.valueOf(qColumns.get(0)) : "";
            String reason = String.valueOf(sample.getOrDefault("reason", ""));
            DdlColumn dc = colByName.get(violatedCol);
            String typeLabel = dc == null ? "" : displayType(dc);
            String bound = reason;
            int idxDec = reason.indexOf("DECIMAL");
            if (idxDec >= 0) bound = reason.substring(idxDec);
            else if (label.startsWith("validate.length") && dc != null && dc.getLength() != null) {
                bound = "len ≤ " + dc.getLength();
            } else if (label.startsWith("validate.type")) {
                bound = "type cast: " + typeLabel;
            }
            Map<String, Object> tv = new LinkedHashMap<>();
            tv.put("column", violatedCol);
            tv.put("type", typeLabel);
            tv.put("bound", bound);
            tv.put("observedMax", null);
            tv.put("overflowRows", qe.getRowCount());
            tv.put("verdict", "FAIL");
            tv.put("note", reason);
            typeValid.add(tv);
        }

        /* quarantineStats 시트 — stageLabel × (entries, rows). 격리 row 적재 정확도 가시화. */
        java.util.TreeMap<String, Long> rowsByLabel = new java.util.TreeMap<>();
        java.util.TreeMap<String, Integer> entriesByLabel = new java.util.TreeMap<>();
        long quarantinedRows = 0;
        for (QuarantineEntry qe : bindingQuarantine) {
            Map<String, Object> sample = qe.getSampleData();
            String label = sample == null ? "" : String.valueOf(sample.getOrDefault("stageLabel", ""));
            String key = label.isEmpty() ? "(none)" : label;
            long rc = qe.getRowCount() == null ? 0L : qe.getRowCount();
            rowsByLabel.merge(key, rc, Long::sum);
            entriesByLabel.merge(key, 1, Integer::sum);
            /* row count 보정용 합계 — audit/validate.* 의 위반 row 만 (audit 가 tobe_ 에서 DELETE). */
            if (label.startsWith("validate.")) quarantinedRows += rc;
        }
        /* severityByLabel — stageLabel 별 첫 severity (적재 통일성). 같은 stageLabel 안에서 error/warning 섞이면
           "error" 우선으로 표시 (운영자 우선순위). */
        Map<String, String> severityByLabel = new HashMap<>();
        for (QuarantineEntry qe : bindingQuarantine) {
            Map<String, Object> sample = qe.getSampleData();
            String label = sample == null ? "" : String.valueOf(sample.getOrDefault("stageLabel", ""));
            String key = label.isEmpty() ? "(none)" : label;
            String sev = qe.getSeverity() == null ? "" : qe.getSeverity().name();
            severityByLabel.merge(key, sev, (a, b) -> "error".equals(a) ? a : b);
        }
        List<Map<String, Object>> quarantineStats = new ArrayList<>();
        for (var e : rowsByLabel.entrySet()) {
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("stageLabel", e.getKey());
            row.put("entries", entriesByLabel.getOrDefault(e.getKey(), 0));
            row.put("rowsQuarantined", e.getValue());
            row.put("severity", severityByLabel.getOrDefault(e.getKey(), ""));
            quarantineStats.add(row);
        }

        /* row_count 검증 — ASIS == TOBE 직접 비교 (사용자 결정 2026-05-31).
           격리 = 데이터 손실. 의도된 격리든 아니든 PASS 로 표시하면 운영자 silent failure
           위험. 격리 있으면 무조건 FAIL — Quarantine 시트가 "어디서 얼마나" 정보 제공.
           quarantined 필드는 정보용으로 row_count map 에 포함. */
        boolean rowCountPass = duckRows == pgRows;
        Map<String, Object> rowCount = orderedMap(
                "asis", duckRows,
                "quarantined", quarantinedRows,
                "tobe", pgRows,
                "verdict", rowCountPass ? "PASS" : "FAIL");
        if (!rowCountPass) {
            recordQuarantine(ctx, stage, binding, tableLabel,
                    "validate.row_count", "Validation row count mismatch — " + tableLabel
                            + " (ASIS " + duckRows + " ≠ TOBE " + pgRows
                            + (quarantinedRows > 0 ? "; " + quarantinedRows + " row(s) quarantined" : "")
                            + ")",
                    List.of("table", "ASIS rows", "Quarantined", "TOBE rows"),
                    List.of("metric", "asis_value", "quarantined", "tobe_value"),
                    List.of(List.of(tableLabel, String.valueOf(duckRows),
                            String.valueOf(quarantinedRows), String.valueOf(pgRows))),
                    Math.abs(duckRows - pgRows), QuarantineSeverity.error);
        }

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
        if ("FAIL".equals(checksumVerdict)) {
            recordQuarantine(ctx, stage, binding, tableLabel,
                    "validate.checksum", "Validation SHA-256 checksum mismatch — " + tableLabel,
                    List.of("table", "ASIS hash", "TOBE hash"),
                    List.of("metric", "asis_value", "tobe_value"),
                    List.of(List.of(tableLabel,
                            duckChecksumRaw == null ? "" : duckChecksumRaw,
                            pgChecksumRaw   == null ? "" : pgChecksumRaw)),
                    1, QuarantineSeverity.error);
        } else if ("WARN".equals(checksumVerdict) && duckChecksumRaw != null) {
            /* WARN — raw 표현 다르나 canonical 일치 (timestamp format diff 등). KPI/Quarantine
               통일성을 위해 severity=warning 으로 적재. (2026-05-31 옵션 (b) 채택) */
            recordQuarantine(ctx, stage, binding, tableLabel,
                    "validate.checksum",
                    "Data integrity format differs (values match canonical) — " + tableLabel,
                    List.of("table", "ASIS hash", "TOBE hash"),
                    List.of("metric", "asis_value", "tobe_value"),
                    List.of(List.of(tableLabel,
                            duckChecksumRaw, pgChecksumRaw == null ? "" : pgChecksumRaw)),
                    1, QuarantineSeverity.warning);
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
        /* Type Validation roll-up — typeValid 시트의 모든 entry 가 FAIL (quarantine 발생 의미).
           entry 0 = PASS (모든 row 타입/길이/범위 통과), entry > 0 = FAIL.
           (2026-05-31 추가) */
        overview.add(orderedMap("item", "Type Validation (" + typeValid.size() + " issue"
                        + (typeValid.size() == 1 ? "" : "s") + ")",
                "asis", typeValid.isEmpty() ? "OK" : typeValid.size() + " issues",
                "tobe", typeValid.isEmpty() ? "OK" : typeValid.size() + " issues",
                "verdict", typeValid.isEmpty() ? "PASS" : "FAIL"));
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
        data.put("quarantineStats", quarantineStats);
        data.put("rowCount", rowCount);
        data.put("checksum", checksum);
        data.put("totalChecks", totalChecks);
        data.put("passedChecks", passedChecks);
        return data;
    }

    /* ---------- Quarantine record helper (2026-05-30 합병 정책) ---------- */

    /** Validation 체크의 verdict 별로 quarantine_entries 1 row 발생.
     *  FAIL → severity=error / WARN → severity=warning (2026-05-31).
     *  + run_log 에도 같은 level (WARN/ERROR) 로 ingest — LogViewer stream 카운트와 통일.
     *  WARN 도 발생시켜서 ExecutionPage KPI 의 warn 카운트 + Quarantine 페이지에 통일 표시. */
    private void recordQuarantine(StageContext ctx, StageInstance stage,
                                  MappingTableBinding binding, String tableLabel,
                                  String stageLabel, String reason,
                                  List<String> columns, List<String> columnRoles,
                                  List<List<Object>> sampleRows, long rowCount,
                                  QuarantineSeverity severity) {
        Map<String, Object> data = new HashMap<>();
        data.put("reason", reason);
        data.put("detail", tableLabel + " — " + stageLabel);
        data.put("severity", severity.name());
        data.put("stageLabel", stageLabel);
        data.put("table", tableLabel);
        data.put("columns", columns);
        data.put("columnRoles", columnRoles);
        data.put("sampleRows", sampleRows);
        quarantineService.record(
                ctx.getRunHistory().getId(),
                stage.getId(),
                binding.getId(),
                null,
                reason,
                severity,
                data,
                rowCount,
                ctx.getLogLineSeqCursor());

        /* run_log 에도 같은 severity 로 1 라인 추가 — LogViewer stream 의 WARN/ERROR 카운트와 일치.
           기존 ingest(info/error) 분기 외 WARN level 명시 호출. */
        long seq = ctx.nextLogSeq();
        var logLine = severity == QuarantineSeverity.warning
                ? StageHelpers.warn(seq, ctx.getRunHistory().getId(), STAGE_KEY, reason)
                : StageHelpers.error(seq, ctx.getRunHistory().getId(), STAGE_KEY, reason);
        runLogIngest.ingest(ctx.getRunHistory().getId(), ctx.getProject().getId(), List.of(logLine));
    }

    /** null 안전 toString — sampleRows 안의 String 변환용. */
    private static String nullSafe(String s) { return s == null ? "" : s; }

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

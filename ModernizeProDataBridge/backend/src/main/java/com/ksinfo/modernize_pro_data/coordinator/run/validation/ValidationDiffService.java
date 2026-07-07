package com.ksinfo.modernize_pro_data.coordinator.run.validation;

import com.ksinfo.modernize_pro_data.common.duckdb.DuckDbService;
import com.ksinfo.modernize_pro_data.common.exception.ApiException;
import com.ksinfo.modernize_pro_data.coordinator.ddl.DdlColumn;
import com.ksinfo.modernize_pro_data.coordinator.ddl.DdlColumnRepository;
import com.ksinfo.modernize_pro_data.coordinator.ddl.DdlTable;
import com.ksinfo.modernize_pro_data.coordinator.ddl.DdlTableRepository;
import com.ksinfo.modernize_pro_data.coordinator.load.PgCopyManager;
import com.ksinfo.modernize_pro_data.coordinator.mapping.MappingTableBinding;
import com.ksinfo.modernize_pro_data.coordinator.mapping.MappingTableBindingRepository;
import com.ksinfo.modernize_pro_data.coordinator.run.RunHistory;
import com.ksinfo.modernize_pro_data.coordinator.run.RunHistoryRepository;
import com.ksinfo.modernize_pro_data.coordinator.site.Project;
import com.ksinfo.modernize_pro_data.coordinator.site.ProjectRepository;
import com.ksinfo.modernize_pro_data.coordinator.site.Site;
import com.ksinfo.modernize_pro_data.coordinator.site.SiteRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;

import java.sql.Connection;
import java.sql.ResultSet;
import java.sql.ResultSetMetaData;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.stream.Collectors;

/**
 * Validation drill-down — Data Integrity Check (SHA-256) FAIL 시 어느 row 가 다른지 row-by-row
 * 조회. DuckDB tobe_ ↔ PG TO-BE 양쪽 fetch 후 PK 기반 매칭 + 컬럼 비교.
 *
 * 한계 (2026-05-31 첫 버전):
 *   - PK 없는 binding 은 diff 불가 (note 에 사유 명시)
 *   - PK 순서 LIMIT N row 만 비교 (페이지네이션 후속)
 *   - canonical normalize 안 함 — raw `::text` 비교만 (timestamp format 차이 = "value-diff" 표시)
 */
@Service
@RequiredArgsConstructor
@Slf4j
public class ValidationDiffService {

    /** Drill-down 1 요청당 최대 fetch row 수. 너무 크면 BE/FE 부담. */
    private static final int MAX_FETCH = 1000;

    private final ValidationReportRepository reportRepo;
    private final MappingTableBindingRepository bindingRepo;
    private final RunHistoryRepository runHistoryRepo;
    private final ProjectRepository projectRepo;
    private final SiteRepository siteRepo;
    private final DdlTableRepository ddlTableRepo;
    private final DdlColumnRepository ddlColumnRepo;
    private final DuckDbService duckDbService;
    private final PgCopyManager pgCopyManager;

    public ValidationDiffSampleDto fetchDiff(String runId, String bindingId, int limit) {
        int safeLimit = Math.max(1, Math.min(limit, 200));

        ValidationReport report = reportRepo.findByRunIdAndBindingId(runId, bindingId)
                .orElseThrow(() -> new ApiException("VALIDATION_NOT_FOUND",
                        "Validation report not found for run=" + runId + " binding=" + bindingId,
                        HttpStatus.NOT_FOUND));
        MappingTableBinding binding = bindingRepo.findById(bindingId)
                .orElseThrow(() -> new ApiException("BINDING_NOT_FOUND",
                        "binding=" + bindingId, HttpStatus.NOT_FOUND));
        RunHistory run = runHistoryRepo.findById(runId)
                .orElseThrow(() -> new ApiException("RUN_NOT_FOUND",
                        "run=" + runId, HttpStatus.NOT_FOUND));
        Project project = projectRepo.findById(binding.getProjectId())
                .orElseThrow(() -> new ApiException("PROJECT_NOT_FOUND",
                        "project=" + binding.getProjectId(), HttpStatus.NOT_FOUND));
        Site site = siteRepo.findById(project.getSiteId())
                .orElseThrow(() -> new ApiException("SITE_NOT_FOUND",
                        "site=" + project.getSiteId(), HttpStatus.NOT_FOUND));

        String duckSchema = "run_" + runId.replace("-", "_");
        String tobeSchema = binding.getTobeSchema();
        String tobeTable  = binding.getTobeTable();

        DdlTable tobeDdl = ddlTableRepo
                .findByProjectIdAndSideOrderByOrdinalAsc(project.getId(), "tobe").stream()
                .filter(t -> tobeTable.equals(t.getPhysicalName()))
                .findFirst()
                .orElseThrow(() -> new ApiException("DDL_NOT_FOUND",
                        "TO-BE DDL not found for table=" + tobeTable, HttpStatus.NOT_FOUND));
        List<DdlColumn> cols = ddlColumnRepo.findByTableIdOrderByOrdinalAsc(tobeDdl.getId());
        List<String> pkCols = cols.stream()
                .filter(c -> c.getPkOrder() != null)
                .sorted(Comparator.comparing(DdlColumn::getPkOrder))
                .map(DdlColumn::getPhysicalName)
                .toList();

        if (pkCols.isEmpty()) {
            return new ValidationDiffSampleDto(
                    runId, bindingId, List.of(), safeLimit, 0,
                    "no PK — diff requires PK column(s)",
                    List.of());
        }

        Map<String, Object> dbConfig = site.getActiveTobeDbConfig();
        if (dbConfig == null) {
            return new ValidationDiffSampleDto(
                    runId, bindingId, pkCols, safeLimit, 0,
                    "TO-BE DB config not set", List.of());
        }

        String fqDuck = quote(duckSchema) + "." + quote("tobe_" + tobeTable);
        String fqPg   = (tobeSchema == null || tobeSchema.isBlank())
                ? quote(tobeTable)
                : quote(tobeSchema) + "." + quote(tobeTable);
        String allColsSel = cols.stream().map(c -> quote(c.getPhysicalName()))
                .collect(Collectors.joining(", "));
        String orderBy = pkCols.stream().map(ValidationDiffService::quote)
                .collect(Collectors.joining(", "));

        /* Overscan — diff 만 추리려면 한쪽 row 가 다른쪽에 매칭 안 될 수 있어 limit 보다 더 가져옴.
           단 MAX_FETCH 로 cap (BE 부담 방지). */
        int fetchSize = Math.min(safeLimit * 5, MAX_FETCH);

        String duckQ = "SELECT " + allColsSel + " FROM " + fqDuck
                + " ORDER BY " + orderBy + " LIMIT " + fetchSize;
        String pgQ   = "SELECT " + allColsSel + " FROM " + fqPg
                + " ORDER BY " + orderBy + " LIMIT " + fetchSize;

        try (Statement duckSt = duckDbService.statement();
             Connection pgConn = pgCopyManager.openConnection(dbConfig);
             Statement pgSt = pgConn.createStatement()) {

            Map<String, Map<String, Object>> duckRows = fetchAsPkMap(duckSt, duckQ, pkCols);
            Map<String, Map<String, Object>> pgRows   = fetchAsPkMap(pgSt,   pgQ,   pkCols);

            Set<String> allKeys = new LinkedHashSet<>();
            allKeys.addAll(duckRows.keySet());
            allKeys.addAll(pgRows.keySet());

            List<ValidationDiffSampleDto.DiffRow> diffs = new ArrayList<>();
            int totalDiff = 0;
            for (String key : allKeys) {
                Map<String, Object> d = duckRows.get(key);
                Map<String, Object> p = pgRows.get(key);
                ValidationDiffSampleDto.DiffRow diffRow = null;
                if (d == null && p != null) {
                    diffRow = new ValidationDiffSampleDto.DiffRow(
                            extractPk(p, pkCols), "tobe-only", List.of());
                } else if (d != null && p == null) {
                    diffRow = new ValidationDiffSampleDto.DiffRow(
                            extractPk(d, pkCols), "asis-only", List.of());
                } else if (d != null) {
                    List<ValidationDiffSampleDto.ColumnDiff> colDiffs = new ArrayList<>();
                    for (DdlColumn col : cols) {
                        if (col.getPkOrder() != null) continue;
                        Object av = d.get(col.getPhysicalName());
                        Object pv = p.get(col.getPhysicalName());
                        if (!eqValue(av, pv)) {
                            colDiffs.add(new ValidationDiffSampleDto.ColumnDiff(
                                    col.getPhysicalName(), av, pv));
                        }
                    }
                    if (!colDiffs.isEmpty()) {
                        diffRow = new ValidationDiffSampleDto.DiffRow(
                                extractPk(d, pkCols), "value-diff", colDiffs);
                    }
                }
                if (diffRow != null) {
                    totalDiff++;
                    if (diffs.size() < safeLimit) diffs.add(diffRow);
                }
            }

            String note = null;
            if (allKeys.size() >= fetchSize) {
                note = "scanned first " + fetchSize + " rows only (PK order). Larger diffs not surfaced.";
            }
            return new ValidationDiffSampleDto(
                    runId, bindingId, pkCols, safeLimit, totalDiff, note, diffs);

        } catch (Exception e) {
            log.warn("diff fetch failed run={} binding={}: {}", runId, bindingId, e.getMessage());
            throw new ApiException("VALIDATION_DIFF_FAILED",
                    "Diff fetch failed: " + e.getMessage(),
                    HttpStatus.INTERNAL_SERVER_ERROR);
        }
    }

    /* ---------- 유틸 ---------- */

    private static Map<String, Map<String, Object>> fetchAsPkMap(
            Statement st, String sql, List<String> pkCols) throws Exception {
        Map<String, Map<String, Object>> out = new LinkedHashMap<>();
        try (ResultSet rs = st.executeQuery(sql)) {
            ResultSetMetaData md = rs.getMetaData();
            int n = md.getColumnCount();
            String[] colNames = new String[n];
            for (int i = 1; i <= n; i++) colNames[i - 1] = md.getColumnLabel(i);
            while (rs.next()) {
                Map<String, Object> row = new HashMap<>();
                for (int i = 1; i <= n; i++) row.put(colNames[i - 1], rs.getObject(i));
                StringBuilder key = new StringBuilder();
                for (int i = 0; i < pkCols.size(); i++) {
                    if (i > 0) key.append('');  // unit separator — 충돌 가능성 낮음
                    Object v = row.get(pkCols.get(i));
                    key.append(v == null ? " " : v.toString());
                }
                out.put(key.toString(), row);
            }
        }
        return out;
    }

    private static List<Object> extractPk(Map<String, Object> row, List<String> pkCols) {
        List<Object> pk = new ArrayList<>(pkCols.size());
        for (String c : pkCols) pk.add(row.get(c));
        return pk;
    }

    /** raw 비교 — null safe + toString 일치. timestamp format 차이 = "value-diff" 로 surface. */
    private static boolean eqValue(Object a, Object b) {
        if (a == null && b == null) return true;
        if (a == null || b == null) return false;
        return Objects.equals(a.toString(), b.toString());
    }

    private static String quote(String name) {
        return "\"" + name.replace("\"", "\"\"") + "\"";
    }
}

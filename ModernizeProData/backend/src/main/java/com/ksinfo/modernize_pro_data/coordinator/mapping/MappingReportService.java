package com.ksinfo.modernize_pro_data.coordinator.mapping;

import com.ksinfo.modernize_pro_data.common.duckdb.DuckDbService;
import com.ksinfo.modernize_pro_data.common.exception.ApiException;
import com.ksinfo.modernize_pro_data.coordinator.site.Project;
import com.ksinfo.modernize_pro_data.coordinator.site.ProjectRepository;
import com.ksinfo.modernize_pro_data.coordinator.site.Site;
import com.ksinfo.modernize_pro_data.coordinator.site.SiteRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.sql.ResultSet;
import java.sql.ResultSetMetaData;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Stream;

/**
 * Mapping Report — TO-BE 테이블의 매핑 룰 + 바인딩을 SQL 한 방으로 묶어 DuckDB 로 실행.
 * 결과는 변환식이 실제로 적용된 row 들. AS-IS CSV 를 read_csv 로 읽고, transform_sql /
 * transform_rule 을 SELECT 식으로 그대로 인젝션.
 *
 * 가정: TO-BE = PostgreSQL. DuckDB 가 PG-호환 함수 (NULLIF, CASE, SUBSTR, TO_DATE,
 * ||, AT TIME ZONE 등) 대부분 지원하므로 transform 그대로 사용 가능.
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class MappingReportService {

    private static final int MAX_LIMIT = 1000;

    private final DuckDbService duckDbService;
    private final ProjectRepository projectRepository;
    private final SiteRepository siteRepository;
    private final MappingTableBindingRepository bindingRepo;
    private final MappingRuleRepository ruleRepo;

    public record ReportResult(
            String tobeSchema,
            String tobeTable,
            List<String> headers,
            List<List<String>> rows,
            int rowCount,
            boolean truncated,
            String sql,
            String error,            // legacy 한국어 메시지 (i18n 전 fallback / 로그용)
            String errorKind,        // EXPRESSION_FAILED | FROM_FAILED | NO_RULES | UNKNOWN | null
            String errorColumn,      // EXPRESSION_FAILED 일 때 컬럼명
            String errorExpression,  // EXPRESSION_FAILED 일 때 표현식
            String errorType         // SYNTAX | BINDER | CATALOG | CONVERSION | IO | UNKNOWN | null
    ) {}

    @Transactional(readOnly = true)
    public ReportResult runReport(String projectId, String tobeSchema, String tobeTable, int limit) {
        if (tobeTable == null || tobeTable.isBlank()) {
            throw new ApiException("REPORT_INVALID",
                    "tobeTable 이 비어있습니다", HttpStatus.BAD_REQUEST);
        }
        int effLimit = Math.min(Math.max(limit, 1), MAX_LIMIT);
        String schema = tobeSchema == null ? "" : tobeSchema;

        Project project = projectRepository.findById(projectId).orElseThrow(() ->
                new ApiException("PROJECT_NOT_FOUND", "프로젝트를 찾을 수 없습니다", HttpStatus.NOT_FOUND));
        Site site = siteRepository.findById(project.getSiteId()).orElseThrow(() ->
                new ApiException("SITE_NOT_FOUND", "사이트를 찾을 수 없습니다", HttpStatus.NOT_FOUND));
        String csvPath = site.getCsvPath();
        if (csvPath == null || csvPath.isBlank()) {
            throw new ApiException("CSV_PATH_NOT_SET",
                    "사이트에 CSV 경로가 설정되지 않았습니다", HttpStatus.BAD_REQUEST);
        }
        Path baseDir;
        try {
            baseDir = Paths.get(csvPath).toAbsolutePath().normalize();
        } catch (Exception e) {
            throw new ApiException("CSV_PATH_INVALID",
                    "CSV 경로 형식이 잘못되었습니다: " + csvPath, HttpStatus.BAD_REQUEST);
        }
        if (!Files.isDirectory(baseDir)) {
            throw new ApiException("CSV_PATH_NOT_DIRECTORY",
                    "CSV 경로가 디렉터리가 아닙니다", HttpStatus.BAD_REQUEST);
        }

        MappingTableBinding binding = bindingRepo
                .findByProjectIdAndTobeSchemaAndTobeTable(projectId, schema, tobeTable)
                .orElse(null);
        List<MappingRule> rules = ruleRepo.findByProjectIdAndTobeTable(projectId, tobeTable).stream()
                .filter(r -> (r.getTobeSchema() == null ? "" : r.getTobeSchema()).equals(schema))
                .sorted(Comparator.comparing(MappingRule::getTobeColumn))
                .toList();

        if (rules.isEmpty()) {
            return new ReportResult(schema, tobeTable, List.of(), List.of(), 0, false, null,
                    "이 TO-BE 테이블에 적용된 mapping_rules 가 없습니다. Mapping definition 임포트 후 다시 시도하세요.",
                    "NO_RULES", null, null, null);
        }

        String sql = buildSql(binding, rules, baseDir, effLimit);

        List<String> headers = new ArrayList<>();
        List<List<String>> outRows = new ArrayList<>();
        boolean truncated = false;
        try (Statement st = duckDbService.statement();
             ResultSet rs = st.executeQuery(sql)) {
            ResultSetMetaData md = rs.getMetaData();
            int colCount = md.getColumnCount();
            for (int i = 1; i <= colCount; i++) headers.add(md.getColumnLabel(i));
            int n = 0;
            while (rs.next()) {
                if (n >= effLimit) { truncated = true; break; }
                List<String> row = new ArrayList<>(colCount);
                for (int i = 1; i <= colCount; i++) {
                    String v = rs.getString(i);
                    row.add(v != null ? v : "");
                }
                outRows.add(row);
                n++;
            }
        } catch (SQLException e) {
            log.warn("Report SQL failed: {}", e.getMessage());
            return identifyFailingRule(schema, tobeTable, headers, sql, binding, rules, baseDir, e.getMessage());
        }
        return new ReportResult(schema, tobeTable, headers, outRows, outRows.size(), truncated, sql, null,
                null, null, null, null);
    }

    /**
     * 한 방의 SELECT 가 실패했을 때, FROM 절을 그대로 두고 컬럼별로 expression 만 바꿔
     * probe 쿼리를 돌려서 어느 변환식이 문제인지 식별한다. 결과는 구조화된 ReportResult
     * 로 반환 — 프론트가 i18n 키로 메시지를 합성한다 (errorKind / errorColumn /
     * errorExpression / errorType). legacy `error` 필드는 한국어 fallback.
     *
     *   1. FROM 자체가 실패하면 → FROM_FAILED + errorType
     *   2. FROM OK → 각 rule 의 expression 을 차례로 probe → 첫 실패 EXPRESSION_FAILED
     *   3. 둘 다 식별 못 하면 UNKNOWN + 원본 메시지
     */
    private ReportResult identifyFailingRule(String schema, String tobeTable, List<String> headers,
                                             String sql, MappingTableBinding binding,
                                             List<MappingRule> rules, Path baseDir, String origMessage) {
        String origType = classifyDuckDbErrorCode(origMessage);
        if (binding == null || binding.getSources().isEmpty()) {
            return errorResult(schema, tobeTable, headers, sql, "UNKNOWN", null, null, origType,
                    "오류 종류: " + classifyDuckDbErrorMessage(origMessage));
        }
        String fromClause = buildFromClause(binding, rules, baseDir);
        if (fromClause.isEmpty()) {
            return errorResult(schema, tobeTable, headers, sql, "UNKNOWN", null, null, origType,
                    "오류 종류: " + classifyDuckDbErrorMessage(origMessage));
        }
        // 1. FROM 자체 검증
        String fromProbe = "SELECT 1 " + fromClause + " LIMIT 0";
        try (Statement st = duckDbService.statement();
             ResultSet rs = st.executeQuery(fromProbe)) {
            // OK — FROM 은 문제 없음
        } catch (SQLException e) {
            log.warn("Report FROM-clause probe failed: {}", e.getMessage());
            String t = classifyDuckDbErrorCode(e.getMessage());
            return errorResult(schema, tobeTable, headers, sql, "FROM_FAILED", null, null, t,
                    "AS-IS 데이터 로드 또는 JOIN/WHERE 절에서 오류가 발생했습니다.\n"
                            + "오류 종류: " + classifyDuckDbErrorMessage(e.getMessage()));
        }
        // 2. expression 별 검증
        for (MappingRule r : rules) {
            if ("skip".equals(r.getStrategy())) continue;
            String expr = exprForRule(r);
            if ("NULL".equals(expr)) continue;  // 상수 NULL 은 검증 의미 없음
            String probe = "SELECT " + expr + " AS probe " + fromClause + " LIMIT 0";
            try (Statement st = duckDbService.statement();
                 ResultSet rs = st.executeQuery(probe)) {
                // OK
            } catch (SQLException e) {
                log.warn("Report expression probe failed for column {}: {}", r.getTobeColumn(), e.getMessage());
                String t = classifyDuckDbErrorCode(e.getMessage());
                return errorResult(schema, tobeTable, headers, sql,
                        "EXPRESSION_FAILED", r.getTobeColumn(), expr, t,
                        "컬럼 \"" + r.getTobeColumn() + "\" 의 변환식에서 오류가 발생했습니다.\n"
                                + "표현식: " + expr + "\n"
                                + "오류 종류: " + classifyDuckDbErrorMessage(e.getMessage()));
            }
        }
        // 식별 실패 — UNKNOWN
        return errorResult(schema, tobeTable, headers, sql, "UNKNOWN", null, null, origType,
                "오류 종류: " + classifyDuckDbErrorMessage(origMessage));
    }

    private static ReportResult errorResult(String schema, String tobeTable, List<String> headers,
                                            String sql, String kind, String col, String expr,
                                            String type, String legacy) {
        return new ReportResult(schema, tobeTable, headers, List.of(), 0, false, sql, legacy,
                kind, col, expr, type);
    }

    /** DuckDB 메시지 → 구조화 type 코드 (프론트 i18n 키 매칭용). */
    private static String classifyDuckDbErrorCode(String msg) {
        if (msg == null) return "UNKNOWN";
        if (msg.contains("Parser Error"))     return "SYNTAX";
        if (msg.contains("Binder Error"))     return "BINDER";
        if (msg.contains("Catalog Error"))    return "CATALOG";
        if (msg.contains("Conversion Error")) return "CONVERSION";
        if (msg.contains("IO Error"))         return "IO";
        return "UNKNOWN";
    }

    /** DuckDB 메시지 → 한국어 라벨 (legacy `error` 필드 fallback용). */
    private static String classifyDuckDbErrorMessage(String msg) {
        return switch (classifyDuckDbErrorCode(msg)) {
            case "SYNTAX"     -> "SQL 문법 오류 (지원하지 않는 구문)";
            case "BINDER"     -> "참조 오류 (컬럼/별칭/타입을 찾을 수 없음)";
            case "CATALOG"    -> "함수 또는 타입을 찾을 수 없음";
            case "CONVERSION" -> "타입 변환 실패";
            case "IO"         -> "파일 읽기 실패";
            default           -> "실행 오류";
        };
    }

    /**
     * 한 TO-BE 테이블에 대한 SELECT SQL 생성.
     * 룰들의 transform_sql (없으면 transform_rule) 을 그대로 SELECT 식으로 인젝션 + AS tobeColumn.
     * 바인딩이 있으면 read_csv FROM + JOIN + WHERE 까지 붙임 (FROM 구성은 buildFromClause 에 위임).
     */
    private String buildSql(MappingTableBinding binding, List<MappingRule> rules, Path baseDir, int limit) {
        StringBuilder select = new StringBuilder("SELECT ");
        boolean first = true;
        for (MappingRule r : rules) {
            if ("skip".equals(r.getStrategy())) continue;
            if (!first) select.append(", ");
            first = false;
            select.append(exprForRule(r)).append(" AS ").append(quoteIdent(r.getTobeColumn()));
        }
        if (first) {
            // 전부 skip — 빈 SELECT 는 invalid. 룰 없음과 동일하게 NULL 반환.
            return "SELECT NULL LIMIT 0";
        }

        String fromClause = buildFromClause(binding, rules, baseDir);
        if (fromClause.isEmpty()) {
            // No source → defaults only. 한 row 짜리 SELECT.
            return select.append(" LIMIT 1").toString();
        }
        return select.toString() + fromClause + " LIMIT " + limit;
    }

    /**
     * FROM ... [JOIN ...] [WHERE ...] 부분만 생성. 앞에 공백 포함.
     * binding 이 없거나 sources 가 비면 빈 문자열 반환.
     * identifyFailingRule 의 probe 쿼리도 이걸 재사용.
     */
    private String buildFromClause(MappingTableBinding binding, List<MappingRule> rules, Path baseDir) {
        if (binding == null || binding.getSources().isEmpty()) return "";
        var sources = binding.getSources().stream()
                .sorted(Comparator.comparingInt(MappingTableBindingSource::getOrdinal))
                .toList();
        StringBuilder from = new StringBuilder(" FROM ");
        for (int i = 0; i < sources.size(); i++) {
            var s = sources.get(i);
            String csvPath = resolveCsvFile(baseDir, s.getAsisTable());
            String escPath = csvPath.replace("'", "''");
            String aliasQ = quoteIdent(s.getAlias());
            String typesClause = buildTypesClause(s.getAsisTable(), rules);
            String readCsv = "read_csv('" + escPath
                    + "', header=true, delim=',', null_padding=true"
                    + (typesClause.isEmpty() ? "" : ", " + typesClause)
                    + ") " + aliasQ;
            if (i == 0) {
                from.append(readCsv);
            } else if ("union".equals(s.getRole())) {
                // UNION ALL 은 SELECT 자체가 달라지므로 PoC 에선 미지원 — 첫 source 만 사용
                log.warn("UNION composition is not yet supported in report SQL — skipping {}", s.getAsisTable());
            } else {
                String joinType = s.getJoinType() != null && !s.getJoinType().isBlank()
                        ? s.getJoinType() : "LEFT JOIN";
                from.append(" ").append(joinType).append(" ").append(readCsv);
                String joinOn = s.getJoinOn();
                if (joinOn != null && !joinOn.isBlank()) {
                    from.append(" ON ").append(joinOn);
                } else {
                    from.append(" ON 1=1");  // 미지정이면 cartesian (사용자가 채워야 함)
                }
            }
        }
        if (binding.getWhereFilter() != null && !binding.getWhereFilter().isBlank()) {
            from.append(" WHERE ").append(binding.getWhereFilter());
        }
        return from.toString();
    }

    private String exprForRule(MappingRule r) {
        String s = r.getStrategy();
        if ("null".equals(s)) return "NULL";
        if ("default".equals(s)) {
            String def = r.getDefaultValue();
            return (def != null && !def.isBlank()) ? def : "NULL";
        }
        // expression — 명시적 CAST 를 TRY_CAST 로 치환해서 캐스트 실패는 NULL 로.
        // (DuckDB 1.1 엔 expression-level TRY wrapper 가 없어서 cast 단위 fallback 만 가능)
        String expr = r.getTransformSql();
        if (expr == null || expr.isBlank()) expr = r.getTransformRule();
        if (expr == null || expr.isBlank()) return "NULL";
        String safe = expr.replaceAll("(?i)\\bCAST\\s*\\(", "TRY_CAST(");
        return "(" + safe + ")";
    }

    private static String quoteIdent(String name) {
        return "\"" + name.replace("\"", "\"\"") + "\"";
    }

    /**
     * 한 AS-IS 테이블의 컬럼별 타입을 모아서 read_csv 의 types= 구조체 만듦.
     * 룰의 asis_type 이 채워진 컬럼만. asis_type 비어있으면 자동 추론에 맡김.
     */
    private static String buildTypesClause(String asisTable, List<MappingRule> rules) {
        if (asisTable == null) return "";
        Map<String, String> types = new LinkedHashMap<>();
        for (MappingRule r : rules) {
            if (!asisTable.equals(r.getAsisTable())) continue;
            if (r.getAsisColumn() == null || r.getAsisType() == null) continue;
            String duck = oracleToDuckDbType(r.getAsisType());
            if (duck != null) types.putIfAbsent(r.getAsisColumn(), duck);
        }
        if (types.isEmpty()) return "";
        StringBuilder sb = new StringBuilder("types={");
        boolean first = true;
        for (var e : types.entrySet()) {
            if (!first) sb.append(", ");
            first = false;
            sb.append("'").append(e.getKey().replace("'", "''")).append("': '")
              .append(e.getValue()).append("'");
        }
        sb.append("}");
        return sb.toString();
    }

    /** Oracle 타입을 DuckDB 타입으로 매핑. 못 맞히면 VARCHAR. */
    private static String oracleToDuckDbType(String oracleType) {
        if (oracleType == null) return null;
        String t = oracleType.toUpperCase().trim();
        // TIMESTAMP first (more specific)
        if (t.startsWith("TIMESTAMP")) {
            return t.contains("TIME ZONE") ? "TIMESTAMPTZ" : "TIMESTAMP";
        }
        if (t.equals("DATE")) return "TIMESTAMP"; // Oracle DATE 는 시간 포함
        if (t.startsWith("NUMBER")) {
            // NUMBER(p,s) 형태에서 s>0 이면 DECIMAL
            int lp = t.indexOf('('), rp = t.indexOf(')');
            if (lp > 0 && rp > lp) {
                String inside = t.substring(lp + 1, rp);
                if (inside.contains(",")) {
                    String[] parts = inside.split(",");
                    try {
                        int prec = Integer.parseInt(parts[0].trim());
                        int scale = Integer.parseInt(parts[1].trim());
                        return scale > 0 ? "DECIMAL(" + prec + "," + scale + ")" : "BIGINT";
                    } catch (NumberFormatException e) { return "BIGINT"; }
                }
            }
            return "BIGINT";
        }
        if (t.startsWith("VARCHAR") || t.startsWith("CHAR") || t.equals("CLOB") || t.startsWith("NVARCHAR")) {
            return "VARCHAR";
        }
        if (t.startsWith("BLOB") || t.startsWith("RAW")) return "BLOB";
        if (t.equals("FLOAT") || t.equals("REAL")) return "DOUBLE";
        if (t.startsWith("BINARY_DOUBLE") || t.startsWith("BINARY_FLOAT")) return "DOUBLE";
        return "VARCHAR"; // safest fallback
    }

    /** baseDir 에서 {asis_table}.csv 를 case-insensitive 검색. 못 찾으면 그래도 그 path 반환 (SQL 이 알아서 에러). */
    private String resolveCsvFile(Path baseDir, String asisTable) {
        if (asisTable == null) return baseDir.resolve("missing.csv").toString();
        String want = (asisTable + ".csv").toLowerCase();
        try (Stream<Path> stream = Files.list(baseDir)) {
            return stream
                    .filter(Files::isRegularFile)
                    .filter(p -> p.getFileName().toString().toLowerCase().equals(want))
                    .findFirst()
                    .map(Path::toString)
                    .orElseGet(() -> baseDir.resolve(asisTable + ".csv").toString());
        } catch (IOException e) {
            return baseDir.resolve(asisTable + ".csv").toString();
        }
    }
}

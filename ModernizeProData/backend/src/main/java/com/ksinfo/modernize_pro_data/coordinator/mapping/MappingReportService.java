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
            String errorType,        // SYNTAX | BINDER | CATALOG | CONVERSION | IO | UNKNOWN | null
            String errorHint         // DuckDB raw 메시지의 첫 줄 (값/포맷/참조 등 결정적 힌트)
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

        // 자식 link 라면 master 의 binding + rules 로 swap. 자식 측의 site csvPath 그대로 사용
        // (자식 의 데이터에 master 의 변환 룰 적용).
        String ruleSourceProjectId = projectId;
        if (binding != null && binding.getSharedFromProjectId() != null) {
            String masterProjectId = binding.getSharedFromProjectId();
            MappingTableBinding masterBinding = bindingRepo
                    .findByProjectIdAndTobeSchemaAndTobeTable(masterProjectId, schema, tobeTable)
                    .orElse(null);
            if (masterBinding != null) {
                binding = masterBinding;
                ruleSourceProjectId = masterProjectId;
            }
        }

        final String effRuleSourceProjectId = ruleSourceProjectId;
        List<MappingRule> rules = ruleRepo.findByProjectIdAndTobeTable(effRuleSourceProjectId, tobeTable).stream()
                .filter(r -> (r.getTobeSchema() == null ? "" : r.getTobeSchema()).equals(schema))
                .sorted(Comparator.comparing(MappingRule::getTobeColumn))
                .toList();

        if (rules.isEmpty()) {
            return new ReportResult(schema, tobeTable, List.of(), List.of(), 0, false, null,
                    "이 TO-BE 테이블에 적용된 mapping_rules 가 없습니다. Mapping definition 임포트 후 다시 시도하세요.",
                    "NO_RULES", null, null, null, null);
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
                null, null, null, null, null);
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
        String origHint = extractHint(origMessage);
        if (binding == null || binding.getSources().isEmpty()) {
            return errorResult(schema, tobeTable, headers, sql, "UNKNOWN", null, null, origType, origHint,
                    "오류 종류: " + classifyDuckDbErrorMessage(origMessage));
        }
        String fromClause = buildFromClause(binding, rules, baseDir);
        if (fromClause.isEmpty()) {
            return errorResult(schema, tobeTable, headers, sql, "UNKNOWN", null, null, origType, origHint,
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
            return errorResult(schema, tobeTable, headers, sql, "FROM_FAILED", null, null, t, extractHint(e.getMessage()),
                    "AS-IS 데이터 로드 또는 JOIN/WHERE 절에서 오류가 발생했습니다.\n"
                            + "오류 종류: " + classifyDuckDbErrorMessage(e.getMessage()));
        }
        // 2. expression 별 검증.
        // LIMIT 0 은 parsing/binding 만 본다 — CAST/STRPTIME 같은 runtime conversion 실패는
        // 데이터를 실제로 흘려야 잡힌다. PROBE_LIMIT rows 만큼 실제 변환을 시도하면
        // "어느 컬럼" 까지 식별 가능. 컬럼 N 개 × PROBE_LIMIT rows 라 비용 미미.
        final int PROBE_LIMIT = 20;
        for (MappingRule r : rules) {
            if ("skip".equals(r.getStrategy())) continue;
            String expr = exprForRule(r);
            if ("NULL".equals(expr)) continue;  // 상수 NULL 은 검증 의미 없음
            String probe = "SELECT " + expr + " AS probe " + fromClause + " LIMIT " + PROBE_LIMIT;
            try (Statement st = duckDbService.statement();
                 ResultSet rs = st.executeQuery(probe)) {
                // 데이터 실제로 끝까지 흘려서 row-level conversion 도 trigger.
                while (rs.next()) { rs.getObject(1); }
            } catch (SQLException e) {
                log.warn("Report expression probe failed for column {}: {}", r.getTobeColumn(), e.getMessage());
                String t = classifyDuckDbErrorCode(e.getMessage());
                return errorResult(schema, tobeTable, headers, sql,
                        "EXPRESSION_FAILED", r.getTobeColumn(), expr, t, extractHint(e.getMessage()),
                        "컬럼 \"" + r.getTobeColumn() + "\" 의 변환식에서 오류가 발생했습니다.\n"
                                + "표현식: " + expr + "\n"
                                + "오류 종류: " + classifyDuckDbErrorMessage(e.getMessage()));
            }
        }
        // 식별 실패 — UNKNOWN
        return errorResult(schema, tobeTable, headers, sql, "UNKNOWN", null, null, origType, origHint,
                "오류 종류: " + classifyDuckDbErrorMessage(origMessage));
    }

    private static ReportResult errorResult(String schema, String tobeTable, List<String> headers,
                                            String sql, String kind, String col, String expr,
                                            String type, String hint, String legacy) {
        return new ReportResult(schema, tobeTable, headers, List.of(), 0, false, sql, legacy,
                kind, col, expr, type, hint);
    }

    /**
     * DuckDB 의 raw 에러 메시지에서 결정적 힌트 한 줄만 추출.
     *   예) "Conversion Error: Could not parse string \"2024/03/31\" according to format specifier \"%Y-%m-%d\""
     *       → "Could not parse string \"2024/03/31\" according to format specifier \"%Y-%m-%d\""
     * "{Type} Error:" prefix 제거, 첫 줄 + 길이 200 자 캡.
     */
    private static String extractHint(String msg) {
        if (msg == null) return null;
        String stripped = msg.replaceAll("(?i)^\\s*(parser|binder|catalog|conversion|io|runtime|invalid input|out of range)\\s+error:\\s*", "").trim();
        int newline = stripped.indexOf('\n');
        if (newline > 0) stripped = stripped.substring(0, newline).trim();
        if (stripped.length() > 200) stripped = stripped.substring(0, 197) + "...";
        return stripped.isEmpty() ? null : stripped;
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
            String csvPath = resolveCsvFile(baseDir, s.getAsisSchema(), s.getAsisTable());
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
        // 식에 라인 주석(--)이 있으면 SELECT 한 줄로 합쳐질 때 뒤따르는 ") AS col, ..." 까지
        // 주석 처리되어 SQL 이 깨진다. 앞뒤에 개행을 넣어 라인 주석이 그 줄에서만 끝나게 한다.
        return "(\n" + safe + "\n)";
    }

    private static String quoteIdent(String name) {
        return "\"" + name.replace("\"", "\"\"") + "\"";
    }

    /**
     * 한 AS-IS 테이블의 컬럼별 타입을 모아서 read_csv 의 types= 구조체 만듦.
     * asis_column / asis_type 은 PG TEXT[] 매핑 String[] — combine 시 여러 원소.
     * 같은 index 끼리 짝지어 types 맵에 등록.
     */
    private static String buildTypesClause(String asisTable, List<MappingRule> rules) {
        if (asisTable == null) return "";
        Map<String, String> types = new LinkedHashMap<>();
        for (MappingRule r : rules) {
            if (!asisTable.equals(r.getAsisTable())) continue;
            String[] cols = r.getAsisColumn();
            if (cols == null || cols.length == 0) continue;
            String[] typs = r.getAsisType() == null ? new String[0] : r.getAsisType();
            for (int i = 0; i < cols.length; i++) {
                String col = cols[i] == null ? "" : cols[i].trim();
                if (col.isEmpty()) continue;
                String typ = i < typs.length && typs[i] != null ? typs[i].trim() : "";
                if (typ.isEmpty()) continue;  // 타입 미명시 — 자동 추론에 맡김
                String duck = oracleToDuckDbType(typ);
                if (duck != null) types.putIfAbsent(col, duck);
            }
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

    /**
     * baseDir 에서 CSV 파일을 case-insensitive 로 검색.
     * 우선순위:
     *   1) {schema}.{table}.csv  (예: RECRUIT.APPLICANTS.csv)
     *   2) {table}.csv           (예: m_employee.csv)
     * 못 찾으면 fallback path 반환 — SQL 이 알아서 IO Error 던지도록 둠.
     */
    private String resolveCsvFile(Path baseDir, String asisSchema, String asisTable) {
        if (asisTable == null) return baseDir.resolve("missing.csv").toString();
        List<String> wants = new ArrayList<>();
        if (asisSchema != null && !asisSchema.isBlank()) {
            wants.add((asisSchema + "." + asisTable + ".csv").toLowerCase());
        }
        wants.add((asisTable + ".csv").toLowerCase());
        try (Stream<Path> stream = Files.list(baseDir)) {
            List<Path> files = stream.filter(Files::isRegularFile).toList();
            for (String want : wants) {
                for (Path p : files) {
                    if (p.getFileName().toString().toLowerCase().equals(want)) {
                        return p.toString();
                    }
                }
            }
        } catch (IOException e) {
            // fallthrough
        }
        return baseDir.resolve(asisTable + ".csv").toString();
    }
}

package com.ksinfo.modernize_pro_data.coordinator.ddl.parser;

import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import javax.sql.DataSource;
import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.TreeMap;
import java.util.UUID;

/**
 * TO-BE PG DDL を一時 schema に適用し pg_catalog / information_schema から
 * テーブル・カラム・インデックス・制約メタを抽出して ParsedDdl を返す.
 *
 * Coordinator 의 메타 PG 18 (default DataSource) 안의 임시 schema 를 사용한다.
 * 외부 target PG への接続権限は不要 — staging は完全に内製.
 *
 * 制限 (PoC):
 *   - TO-BE DDL は **schema prefix 없이** (unqualified) 作成すること. schema prefix が
 *     ある場合, その schema が PG に存在しないと適用失敗 → ユーザーに「PG 文法で書き直し」
 *     のエラーを返す.
 *   - DDL は PG syntactically valid であること. Oracle 文法は PG が拒否 → 適用失敗.
 *   - multi-statement: PG JDBC driver が一括 Statement.execute(sql) で複数文を受ける.
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class PgSchemaExtractor {

    private final DataSource dataSource;

    public ParsedDdl extract(byte[] content) {
        String raw = new String(content, StandardCharsets.UTF_8);
        // self-healing — 적용 중 "schema X does not exist"(SQLState 3F000) 가 나오면 그 X 를
        // strip 대상에 추가하고 재시도. dump 이 schema 를 어떤 형태로 참조하든(CREATE SCHEMA 유무
        // 무관) 결국 모든 schema 한정자가 제거돼 staging 으로 유입된다. (schema 종류 만큼만 반복)
        java.util.Set<String> extraStrip = new java.util.LinkedHashSet<>();
        SQLException lastError = null;
        for (int attempt = 0; attempt < 8; attempt++) {
            String stagingSchema = "tobe_ddl_validate_"
                    + UUID.randomUUID().toString().replace("-", "").substring(0, 12);
            String sql = sanitizeDumpForStaging(raw, extraStrip);
            boolean retry = false;
            try (Connection conn = dataSource.getConnection()) {
                conn.setAutoCommit(true);
                try {
                    try (Statement st = conn.createStatement()) {
                        st.execute("CREATE SCHEMA \"" + stagingSchema + "\"");
                        st.execute("SET search_path TO \"" + stagingSchema + "\", public");
                    }
                    try (Statement st = conn.createStatement()) {
                        st.execute(sql);
                    } catch (SQLException e) {
                        String miss = extractMissingSchema(e);
                        if (miss != null && extraStrip.add(miss.toLowerCase(Locale.ROOT))) {
                            lastError = e;
                            retry = true;   // 미식별 schema 발견 → strip 후 재시도
                        } else {
                            throw new TobeDdlApplyException(friendlyApplyError(e, sql), e);
                        }
                    }
                    if (!retry) {
                        ParsedDdl parsed = buildParsedDdl(conn, stagingSchema);
                        // staging 에 적용하느라 schema 한정자를 떼었기 때문에 추출된 테이블의 schema 가
                        // 비어버린다. 원본 dump 의 "<schema>.<table>" 에서 실제 schema(banksys 등)를
                        // 읽어 복원 — 안 하면 mapping/load 가 schema 불일치로 깨진다.
                        restoreOriginalSchemas(parsed, raw);
                        return parsed;
                    }
                } finally {
                    // DISCARD ALL 로 풀 반납 전 세션 초기화 — search_path 오염 누수 차단(42P01 회피).
                    resetSession(conn);
                }
            } catch (SQLException e) {
                throw new RuntimeException("PgSchemaExtractor connection failed: " + e.getMessage(), e);
            } finally {
                cleanupStagingSchema(stagingSchema);
            }
        }
        throw new TobeDdlApplyException(
                "TO-BE DDL 적용 실패 — schema 참조를 해소하지 못했습니다. 원인: "
                        + (lastError != null ? lastError.getMessage() : ""), lastError);
    }

    /**
     * 적용 실패 SQLException 을 사용자가 "무엇이 문제인지" 알 수 있는 메시지로 분류.
     * PG 원문(위치 포함)도 끝에 붙여 정확한 지점을 보게 한다.
     */
    private static String friendlyApplyError(SQLException e, String sql) {
        String state = sqlState(e);
        String raw = e.getMessage() == null ? "" : e.getMessage().trim();
        String low = sql.toLowerCase(Locale.ROOT);

        // 중복 정의 (같은 객체가 파일 안에 두 번).
        if ("42P07".equals(state) || "42710".equals(state) || "42P06".equals(state) || "42723".equals(state)) {
            String name = firstQuoted(raw);
            return (name != null
                    ? "DDL 파일 안에 \"" + name + "\" 이(가) 중복 정의돼 있습니다. 중복을 제거하세요."
                    : "DDL 파일 안에 중복 정의된 객체가 있습니다.")
                    + " (원인: " + raw + ")";
        }
        // Oracle/MySQL 문법을 TO-BE(PostgreSQL)에 넣은 경우.
        if (low.contains("varchar2") || low.contains("nvarchar2") || low.contains("number(")
                || low.contains(" clob") || low.contains("auto_increment") || low.contains("engine=")) {
            return "이 DDL 은 PostgreSQL 문법이 아닌 것 같습니다 (Oracle/MySQL?). "
                    + "TO-BE 는 PostgreSQL DDL 이어야 합니다. (원인: " + raw + ")";
        }
        // 순수 문법 오류.
        if ("42601".equals(state)) {
            return "SQL 문법 오류입니다. 표시된 위치를 확인하세요. (원인: " + raw + ")";
        }
        return "TO-BE DDL 적용 실패. (원인: " + raw + ")";
    }

    /**
     * 원본 dump 의 {@code CREATE TABLE <schema>.<table>} 에서 테이블별 실제 schema 를 읽어
     * 추출된 ParsedTable 에 복원. (staging 적용 시 schema 한정자를 떼어 schema 가 비어버리므로.)
     * dump 에 schema 한정자가 없던 테이블은 그대로 둔다.
     */
    static void restoreOriginalSchemas(ParsedDdl parsed, String rawDump) {
        java.util.Map<String, String> tableSchema = new java.util.HashMap<>();
        java.util.regex.Matcher m = java.util.regex.Pattern.compile(
                "(?i)CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?"
                        + "\"?([A-Za-z_][A-Za-z0-9_$]*)\"?\\s*\\.\\s*\"?([A-Za-z_][A-Za-z0-9_$]*)\"?")
                .matcher(rawDump);
        while (m.find()) {
            String schema = m.group(1);
            String table = m.group(2);
            if (!schema.equalsIgnoreCase("pg_catalog") && !schema.equalsIgnoreCase("information_schema")) {
                tableSchema.put(table.toLowerCase(Locale.ROOT), schema);
            }
        }
        if (tableSchema.isEmpty()) return;
        for (ParsedTable t : parsed.getTables()) {
            String orig = tableSchema.get(t.getPhysicalName().toLowerCase(Locale.ROOT));
            if (orig != null) t.setSchemaName(orig);
        }
    }

    private static String sqlState(SQLException root) {
        for (Throwable t = root; t != null; t = t.getCause()) {
            if (t instanceof SQLException se && se.getSQLState() != null) return se.getSQLState();
        }
        return null;
    }

    private static String firstQuoted(String s) {
        java.util.regex.Matcher m = java.util.regex.Pattern.compile("\"([^\"]+)\"").matcher(s == null ? "" : s);
        return m.find() ? m.group(1) : null;
    }

    /** SQLException 체인에서 invalid_schema_name(3F000) 의 따옴표 schema 명 추출 (메시지 언어 무관). */
    private static String extractMissingSchema(SQLException root) {
        for (Throwable t = root; t != null; t = t.getCause()) {
            if (t instanceof SQLException se && "3F000".equals(se.getSQLState())) {
                String msg = se.getMessage() == null ? "" : se.getMessage();
                java.util.regex.Matcher m = java.util.regex.Pattern.compile("\"([^\"]+)\"").matcher(msg);
                if (m.find()) return m.group(1);
            }
        }
        return null;
    }

    /** 풀 반납 전 connection 세션 상태 초기화 — search_path 오염 누수 차단. best-effort. */
    private void resetSession(Connection conn) {
        try (Statement st = conn.createStatement()) {
            st.execute("DISCARD ALL");
        } catch (SQLException e) {
            log.warn("PgSchemaExtractor session reset (DISCARD ALL) failed: {}", e.getMessage());
        }
    }

    /**
     * 업로드된 TO-BE DDL 을 staging schema 적용에 안전하게 전처리.
     *
     * pg_dump 산출물은 (1) {@code SELECT pg_catalog.set_config('search_path', ...)} / {@code SET
     * search_path} 로 우리 staging 경로를 덮고, (2) {@code public.customer_contacts} 처럼 schema
     * 한정명을 써서 staging 이 아니라 메타 DB 의 public 에 테이블을 만든다 → 재적용 시 "relation
     * already exists", staging 은 비어 "CREATE TABLE 못찾음". (3) {@code OWNER TO}/{@code GRANT}/
     * {@code CREATE SCHEMA} 는 존재하지 않는 role/schema 로 적용 실패.
     *
     * 메타 추출 목적이므로 이들 dump 부가 구문을 제거하고 schema 한정자를 떼어 전부 staging 으로
     * 유입시킨다. (heuristic — 표준 pg_dump 케이스 대응.)
     */
    static String sanitizeDumpForStaging(String sql) {
        return sanitizeDumpForStaging(sql, java.util.Collections.emptySet());
    }

    static String sanitizeDumpForStaging(String sql, java.util.Set<String> extraSchemas) {
        // 1) dump 이 선언/사용하는 schema 이름 수집 (CREATE SCHEMA + search_path + qualified 참조 + public).
        //    이들 <schema>. 한정자를 떼어 전부 staging 으로 유입시킨다.
        java.util.Set<String> schemas = new java.util.LinkedHashSet<>();
        schemas.add("public");
        for (String s : extraSchemas) if (s != null && !s.isBlank()) schemas.add(s);
        java.util.regex.Matcher cs = java.util.regex.Pattern
                .compile("(?im)^\\s*CREATE\\s+SCHEMA\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?\"?([A-Za-z_][A-Za-z0-9_$]*)\"?")
                .matcher(sql);
        while (cs.find()) schemas.add(cs.group(1));
        java.util.regex.Matcher sp = java.util.regex.Pattern
                .compile("(?im)(?:SET\\s+search_path|set_config\\(\\s*'+search_path'+\\s*,)\\s*[=,]?\\s*(.+)$")
                .matcher(sql);
        while (sp.find()) {
            for (String tok : sp.group(1).split(",")) {
                String name = tok.replaceAll("[\"';)]", "").trim();
                if (name.matches("[A-Za-z_][A-Za-z0-9_$]*") && !name.equalsIgnoreCase("false")
                        && !name.equalsIgnoreCase("true") && !name.startsWith("$") && !name.startsWith("pg_")) {
                    schemas.add(name);
                }
            }
        }
        // qualified object 참조에서도 schema 명 수집 — dump 이 CREATE SCHEMA 없이 banksys.tbl 만
        // 써도 banksys 를 잡아낸다. 키워드 뒤의 "<schema>." 패턴.
        java.util.regex.Matcher qr = java.util.regex.Pattern
                .compile("(?i)\\b(?:TABLE|SEQUENCE|INDEX|VIEW|TRIGGER|REFERENCES|ONLY|INTO|JOIN|UPDATE|ON|FROM)\\s+"
                        + "(?:IF\\s+(?:NOT\\s+)?EXISTS\\s+)?(?:ONLY\\s+)?\"?([A-Za-z_][A-Za-z0-9_$]*)\"?\\s*\\.")
                .matcher(sql);
        while (qr.find()) {
            String name = qr.group(1);
            if (!name.startsWith("pg_")) schemas.add(name);
        }

        // 2) dump 부가 구문 제거 (staging 외부 의존 → 적용 실패 회피).
        StringBuilder out = new StringBuilder(sql.length());
        for (String line : sql.split("\n", -1)) {
            String upper = line.trim().toUpperCase(Locale.ROOT);
            String lower = line.trim().toLowerCase(Locale.ROOT);
            if (upper.startsWith("SET SEARCH_PATH")) continue;
            if (lower.contains("set_config('search_path'") || lower.contains("set_config(''search_path''")
                    || lower.contains("set_config( 'search_path'")) continue;
            if (upper.contains(" OWNER TO ")) continue;
            if (upper.startsWith("GRANT ") || upper.startsWith("REVOKE ")) continue;
            if (upper.startsWith("CREATE SCHEMA") || upper.startsWith("ALTER SCHEMA") || upper.startsWith("DROP SCHEMA")) continue;
            // staging(번들 PG) 환경에 없을 수 있는 의존 구문 제거 — 문법은 맞아도 적용 실패하는 것들.
            if (upper.startsWith("CREATE EXTENSION") || upper.startsWith("ALTER EXTENSION")
                    || upper.startsWith("DROP EXTENSION") || upper.startsWith("COMMENT ON EXTENSION")) continue;
            if (upper.startsWith("CREATE ROLE") || upper.startsWith("ALTER ROLE") || upper.startsWith("DROP ROLE")
                    || upper.startsWith("CREATE USER") || upper.startsWith("ALTER USER") || upper.startsWith("DROP USER")) continue;
            if (upper.startsWith("SET DEFAULT_TABLESPACE") || upper.startsWith("SET DEFAULT_TABLE_ACCESS_METHOD")) continue;
            if (upper.contains("SET TABLESPACE")) continue;   // ALTER TABLE ... SET TABLESPACE x;
            out.append(line).append('\n');
        }

        // 3) 수집한 모든 <schema>. 한정자 제거 (quoted/unquoted, 대소문자 무시).
        String body = out.toString();
        for (String sc : schemas) {
            String q = java.util.regex.Pattern.quote(sc);
            body = body.replaceAll("(?i)\\b" + q + "\\.", "");
            body = body.replaceAll("(?i)\"" + q + "\"\\.", "");
        }
        // 4) inline TABLESPACE 절 제거 ( ") TABLESPACE pg_default" 같은 — 없는 tablespace 거부 회피).
        body = body.replaceAll("(?i)\\s+TABLESPACE\\s+\"?[A-Za-z_][A-Za-z0-9_$]*\"?", "");
        return body;
    }

    private void cleanupStagingSchema(String stagingSchema) {
        try (Connection conn = dataSource.getConnection();
             Statement st = conn.createStatement()) {
            st.execute("DROP SCHEMA IF EXISTS \"" + stagingSchema + "\" CASCADE");
        } catch (Exception e) {
            log.warn("staging schema cleanup failed for {}: {}", stagingSchema, e.getMessage());
        }
    }

    private ParsedDdl buildParsedDdl(Connection conn, String schema) throws SQLException {
        List<ParsedTable> tables = loadTables(conn, schema);
        Map<String, ParsedTable> tableByName = new HashMap<>();
        for (ParsedTable t : tables) tableByName.put(t.getPhysicalName(), t);

        for (ParsedTable t : tables) {
            loadColumns(conn, schema, t);
            loadPkOrder(conn, schema, t);
            loadTableAndColumnComments(conn, schema, t);
        }

        List<ParsedConstraint> constraints = loadConstraints(conn, schema);
        // 파티션 자식 테이블(loadTables 에서 제외됨)의 상속 제약도 함께 버린다. 안 그러면
        // 부모와 같은 이름의 제약이 여러 table 로 들어와 중복/노이즈가 된다.
        constraints.removeIf(pc -> !tableByName.containsKey(pc.getTableName()));
        for (ParsedConstraint pc : constraints) {
            if (ParsedConstraint.TYPE_FK.equals(pc.getType())) {
                loadFkColumnsAndRef(conn, schema, pc);
            } else if (ParsedConstraint.TYPE_UK.equals(pc.getType())) {
                loadUkColumns(conn, schema, pc);
            } else if (ParsedConstraint.TYPE_CHECK.equals(pc.getType())) {
                loadCheckExpression(conn, schema, pc);
            }
        }

        List<ParsedIndex> indexes = loadIndexes(conn, schema, constraints);
        indexes.removeIf(pi -> !tableByName.containsKey(pi.getTableName()));  // 파티션 자식 index 제외
        for (ParsedIndex pi : indexes) loadIndexColumns(conn, schema, pi);

        ParsedDdl result = new ParsedDdl(tables);
        result.setIndexes(indexes);
        result.setConstraints(constraints);
        return result;
    }

    private List<ParsedTable> loadTables(Connection conn, String schema) throws SQLException {
        List<ParsedTable> out = new ArrayList<>();
        // relkind 'r'=ordinary table, 'p'=partitioned table(부모). NOT relispartition 으로
        // 파티션 자식 테이블(예: transactions_2023)은 제외 — 파티션은 부모 한 테이블의 물리적
        // 조각이라 매핑 대상이 아니고, 자식을 넣으면 상속 제약이 부모와 같은 이름이라 중복/노이즈.
        // (information_schema.tables 는 부모+자식을 모두 'BASE TABLE' 로 돌려줬음.)
        try (PreparedStatement ps = conn.prepareStatement(
                "SELECT c.relname FROM pg_class c "
                        + "JOIN pg_namespace n ON n.oid = c.relnamespace "
                        + "WHERE n.nspname = ? AND c.relkind IN ('r', 'p') AND NOT c.relispartition "
                        + "ORDER BY c.relname")) {
            ps.setString(1, schema);
            try (ResultSet rs = ps.executeQuery()) {
                int ord = 0;
                while (rs.next()) {
                    ParsedTable t = new ParsedTable();
                    t.setSchemaName("");
                    t.setPhysicalName(rs.getString(1));
                    t.setOrdinal(ord++);
                    out.add(t);
                }
            }
        }
        return out;
    }

    private void loadColumns(Connection conn, String schema, ParsedTable t) throws SQLException {
        try (PreparedStatement ps = conn.prepareStatement(
                "SELECT column_name, ordinal_position, data_type, "
                        + "character_maximum_length, numeric_precision, numeric_scale, "
                        + "is_nullable, column_default, udt_name "
                        + "FROM information_schema.columns "
                        + "WHERE table_schema = ? AND table_name = ? "
                        + "ORDER BY ordinal_position")) {
            ps.setString(1, schema);
            ps.setString(2, t.getPhysicalName());
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    ParsedColumn c = new ParsedColumn();
                    c.setPhysicalName(rs.getString("column_name"));
                    c.setOrdinal(rs.getInt("ordinal_position"));
                    String udt = rs.getString("udt_name");
                    String dataType = udt != null && !udt.isBlank() ? udt : rs.getString("data_type");
                    c.setDataType(dataType.toUpperCase(Locale.ROOT));
                    Integer len = rs.getObject("character_maximum_length") == null
                            ? null : rs.getInt("character_maximum_length");
                    Integer pr = rs.getObject("numeric_precision") == null
                            ? null : rs.getInt("numeric_precision");
                    Integer sc = rs.getObject("numeric_scale") == null
                            ? null : rs.getInt("numeric_scale");
                    c.setLength(len);
                    c.setPrecision(pr);
                    c.setScale(sc);
                    c.setNullable("YES".equalsIgnoreCase(rs.getString("is_nullable")));
                    c.setDefaultValue(rs.getString("column_default"));
                    c.setDataTypeRaw(buildRawType(c.getDataType(), len, pr, sc));
                    t.getColumns().add(c);
                }
            }
        }
    }

    private void loadPkOrder(Connection conn, String schema, ParsedTable t) throws SQLException {
        try (PreparedStatement ps = conn.prepareStatement(
                "SELECT kcu.column_name, kcu.ordinal_position "
                        + "FROM information_schema.table_constraints tc "
                        + "JOIN information_schema.key_column_usage kcu "
                        + "  ON tc.constraint_name = kcu.constraint_name "
                        + " AND tc.table_schema = kcu.table_schema "
                        + "WHERE tc.table_schema = ? AND tc.table_name = ? "
                        + "  AND tc.constraint_type = 'PRIMARY KEY' "
                        + "ORDER BY kcu.ordinal_position")) {
            ps.setString(1, schema);
            ps.setString(2, t.getPhysicalName());
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    String colName = rs.getString("column_name");
                    int pkOrder = rs.getInt("ordinal_position");
                    for (ParsedColumn c : t.getColumns()) {
                        if (c.getPhysicalName().equals(colName)) {
                            c.setPkOrder(pkOrder);
                            c.setNullable(false);
                            break;
                        }
                    }
                }
            }
        }
    }

    private void loadTableAndColumnComments(Connection conn, String schema, ParsedTable t) throws SQLException {
        try (PreparedStatement ps = conn.prepareStatement(
                "SELECT obj_description(c.oid) AS comment "
                        + "FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace "
                        + "WHERE n.nspname = ? AND c.relname = ?")) {
            ps.setString(1, schema);
            ps.setString(2, t.getPhysicalName());
            try (ResultSet rs = ps.executeQuery()) {
                if (rs.next()) {
                    String comment = rs.getString(1);
                    if (comment != null && !comment.isBlank()) {
                        t.setTableComment(comment);
                        t.setLogicalName(comment);
                    }
                }
            }
        }
        try (PreparedStatement ps = conn.prepareStatement(
                "SELECT a.attname, col_description(c.oid, a.attnum) AS comment "
                        + "FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace "
                        + "JOIN pg_attribute a ON a.attrelid = c.oid "
                        + "WHERE n.nspname = ? AND c.relname = ? "
                        + "  AND a.attnum > 0 AND NOT a.attisdropped")) {
            ps.setString(1, schema);
            ps.setString(2, t.getPhysicalName());
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    String cname = rs.getString("attname");
                    String comment = rs.getString("comment");
                    if (comment == null || comment.isBlank()) continue;
                    for (ParsedColumn pc : t.getColumns()) {
                        if (pc.getPhysicalName().equals(cname)) {
                            pc.setColumnComment(comment);
                            pc.setLogicalName(comment);
                            break;
                        }
                    }
                }
            }
        }
    }

    private List<ParsedConstraint> loadConstraints(Connection conn, String schema) throws SQLException {
        List<ParsedConstraint> out = new ArrayList<>();
        try (PreparedStatement ps = conn.prepareStatement(
                "SELECT tc.table_name, tc.constraint_name, tc.constraint_type "
                        + "FROM information_schema.table_constraints tc "
                        + "WHERE tc.table_schema = ? "
                        + "  AND tc.constraint_type IN ('UNIQUE', 'FOREIGN KEY', 'CHECK')")) {
            ps.setString(1, schema);
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    String ctype = rs.getString("constraint_type");
                    ParsedConstraint pc = new ParsedConstraint();
                    pc.setSchemaName("");
                    pc.setTableName(rs.getString("table_name"));
                    pc.setName(rs.getString("constraint_name"));
                    if ("UNIQUE".equals(ctype)) pc.setType(ParsedConstraint.TYPE_UK);
                    else if ("FOREIGN KEY".equals(ctype)) pc.setType(ParsedConstraint.TYPE_FK);
                    else if ("CHECK".equals(ctype)) {
                        // PG 의 system-generated NOT NULL CHECK 는 무시 (constraint_name 이 형식적으로 다름)
                        if (rs.getString("constraint_name").matches(".*_not_null$")) continue;
                        pc.setType(ParsedConstraint.TYPE_CHECK);
                    }
                    out.add(pc);
                }
            }
        }
        return out;
    }

    private void loadUkColumns(Connection conn, String schema, ParsedConstraint pc) throws SQLException {
        try (PreparedStatement ps = conn.prepareStatement(
                "SELECT column_name, ordinal_position "
                        + "FROM information_schema.key_column_usage "
                        + "WHERE constraint_schema = ? AND constraint_name = ? "
                        + "ORDER BY ordinal_position")) {
            ps.setString(1, schema);
            ps.setString(2, pc.getName());
            try (ResultSet rs = ps.executeQuery()) {
                int ord = 1;
                while (rs.next()) {
                    ParsedConstraintColumn cc = new ParsedConstraintColumn();
                    cc.setOrdinal(ord++);
                    cc.setColumnName(rs.getString("column_name"));
                    pc.getColumns().add(cc);
                }
            }
        }
    }

    private void loadFkColumnsAndRef(Connection conn, String schema, ParsedConstraint pc) throws SQLException {
        Map<Integer, String> childByOrd = new TreeMap<>();
        try (PreparedStatement ps = conn.prepareStatement(
                "SELECT column_name, ordinal_position "
                        + "FROM information_schema.key_column_usage "
                        + "WHERE constraint_schema = ? AND constraint_name = ? "
                        + "ORDER BY ordinal_position")) {
            ps.setString(1, schema);
            ps.setString(2, pc.getName());
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    childByOrd.put(rs.getInt("ordinal_position"), rs.getString("column_name"));
                }
            }
        }

        Map<Integer, String> parentByOrd = new TreeMap<>();
        String refTable = null;
        String onDelete = null, onUpdate = null;
        try (PreparedStatement ps = conn.prepareStatement(
                "SELECT rc.delete_rule, rc.update_rule, "
                        + "       kcu2.table_name AS ref_table, "
                        + "       kcu2.column_name AS ref_column, "
                        + "       kcu2.ordinal_position AS ref_ordinal "
                        + "FROM information_schema.referential_constraints rc "
                        + "JOIN information_schema.key_column_usage kcu2 "
                        + "  ON rc.unique_constraint_name = kcu2.constraint_name "
                        + " AND rc.unique_constraint_schema = kcu2.constraint_schema "
                        + "WHERE rc.constraint_schema = ? AND rc.constraint_name = ? "
                        + "ORDER BY kcu2.ordinal_position")) {
            ps.setString(1, schema);
            ps.setString(2, pc.getName());
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    if (refTable == null) {
                        refTable = rs.getString("ref_table");
                        onDelete = rs.getString("delete_rule");
                        onUpdate = rs.getString("update_rule");
                    }
                    parentByOrd.put(rs.getInt("ref_ordinal"), rs.getString("ref_column"));
                }
            }
        }
        if (refTable != null) {
            ParsedForeignKey fk = new ParsedForeignKey();
            fk.setRefTableName(refTable);
            fk.setOnDelete(onDelete == null ? "NO ACTION" : onDelete.toUpperCase(Locale.ROOT));
            fk.setOnUpdate(onUpdate == null ? "NO ACTION" : onUpdate.toUpperCase(Locale.ROOT));
            // information_schema 엔 deferrable 정보 없어 pg_constraint 직접 조회.
            try (PreparedStatement dps = conn.prepareStatement(
                    "SELECT c.condeferrable, c.condeferred "
                            + "FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace "
                            + "WHERE c.conname = ? AND n.nspname = ?")) {
                dps.setString(1, pc.getName());
                dps.setString(2, schema);
                try (ResultSet drs = dps.executeQuery()) {
                    if (drs.next() && drs.getBoolean("condeferrable")) {
                        fk.setDeferrableInfo(drs.getBoolean("condeferred")
                                ? "DEFERRABLE INITIALLY DEFERRED"
                                : "DEFERRABLE INITIALLY IMMEDIATE");
                    }
                }
            }
            pc.setForeignKey(fk);
        }
        int ord = 1;
        for (Map.Entry<Integer, String> e : childByOrd.entrySet()) {
            ParsedConstraintColumn cc = new ParsedConstraintColumn();
            cc.setOrdinal(ord);
            cc.setColumnName(e.getValue());
            cc.setRefColumnName(parentByOrd.get(ord));
            pc.getColumns().add(cc);
            ord++;
        }
    }

    private void loadCheckExpression(Connection conn, String schema, ParsedConstraint pc) throws SQLException {
        try (PreparedStatement ps = conn.prepareStatement(
                "SELECT check_clause FROM information_schema.check_constraints "
                        + "WHERE constraint_schema = ? AND constraint_name = ?")) {
            ps.setString(1, schema);
            ps.setString(2, pc.getName());
            try (ResultSet rs = ps.executeQuery()) {
                if (rs.next()) {
                    pc.setCheckExpression(rs.getString("check_clause"));
                }
            }
        }
    }

    private List<ParsedIndex> loadIndexes(Connection conn, String schema,
                                          List<ParsedConstraint> constraints) throws SQLException {
        List<ParsedIndex> out = new ArrayList<>();
        try (PreparedStatement ps = conn.prepareStatement(
                "SELECT c.relname AS indexname, t.relname AS tablename, "
                        + "       i.indisunique, i.indisprimary, am.amname "
                        + "FROM pg_class c "
                        + "JOIN pg_index i ON i.indexrelid = c.oid "
                        + "JOIN pg_class t ON t.oid = i.indrelid "
                        + "JOIN pg_namespace n ON n.oid = c.relnamespace "
                        + "JOIN pg_am am ON am.oid = c.relam "
                        + "WHERE n.nspname = ? AND NOT i.indisprimary")) {
            ps.setString(1, schema);
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    String iname = rs.getString("indexname");
                    boolean isUnique = rs.getBoolean("indisunique");
                    boolean isUkUnderlying = isUnique && constraints.stream()
                            .anyMatch(c -> ParsedConstraint.TYPE_UK.equals(c.getType())
                                    && c.getName().equals(iname));
                    if (isUkUnderlying) continue;
                    ParsedIndex pi = new ParsedIndex();
                    pi.setSchemaName("");
                    pi.setName(iname);
                    pi.setTableName(rs.getString("tablename"));
                    pi.setUnique(isUnique);
                    pi.setType(rs.getString("amname"));
                    out.add(pi);
                }
            }
        }
        return out;
    }

    private void loadIndexColumns(Connection conn, String schema, ParsedIndex pi) throws SQLException {
        try (PreparedStatement ps = conn.prepareStatement(
                "SELECT a.attname AS column_name, ord.ordinality AS pos "
                        + "FROM pg_class c "
                        + "JOIN pg_index pgi ON pgi.indexrelid = c.oid "
                        + "JOIN pg_namespace n ON n.oid = c.relnamespace "
                        + "JOIN LATERAL unnest(pgi.indkey) WITH ORDINALITY AS ord(attnum, ordinality) ON TRUE "
                        + "JOIN pg_attribute a ON a.attrelid = pgi.indrelid AND a.attnum = ord.attnum "
                        + "WHERE n.nspname = ? AND c.relname = ? "
                        + "ORDER BY ord.ordinality")) {
            ps.setString(1, schema);
            ps.setString(2, pi.getName());
            try (ResultSet rs = ps.executeQuery()) {
                int ord = 1;
                while (rs.next()) {
                    ParsedIndexColumn ic = new ParsedIndexColumn();
                    ic.setOrdinal(ord++);
                    ic.setColumnName(rs.getString("column_name"));
                    pi.getColumns().add(ic);
                }
            }
        }
    }

    private String buildRawType(String dataType, Integer length, Integer precision, Integer scale) {
        String dt = dataType == null ? "" : dataType.toUpperCase(Locale.ROOT);
        StringBuilder sb = new StringBuilder(dataType);
        if (length != null && length > 0) {
            // 문자형 길이 (varchar/char/bpchar). 정수/실수엔 character_maximum_length 가 안 옴.
            sb.append("(").append(length).append(")");
        } else if ((dt.equals("NUMERIC") || dt.equals("DECIMAL")) && precision != null && precision > 0) {
            // 수정자(precision[,scale])는 NUMERIC/DECIMAL 에만 유효. int8/int4/float8 등의
            // numeric_precision(=비트폭 64/32/53)은 타입 수정자가 아니므로 붙이면 안 된다
            // (붙이면 "type modifier is not allowed" 로 CREATE TABLE 실패).
            sb.append("(").append(precision);
            if (scale != null && scale > 0) sb.append(",").append(scale);
            sb.append(")");
        }
        return sb.toString();
    }

    /** TO-BE DDL 적용 실패 시 던지는 명시적 exception. DdlImportService 가 catch 해서 ApiException 으로 변환. */
    public static class TobeDdlApplyException extends RuntimeException {
        public TobeDdlApplyException(String message, Throwable cause) {
            super(message, cause);
        }
    }
}

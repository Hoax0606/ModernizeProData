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
        String stagingId = UUID.randomUUID().toString().replace("-", "").substring(0, 12);
        String stagingSchema = "tobe_ddl_validate_" + stagingId;
        String sql = new String(content, StandardCharsets.UTF_8);

        try (Connection conn = dataSource.getConnection()) {
            conn.setAutoCommit(true);

            try (Statement st = conn.createStatement()) {
                st.execute("CREATE SCHEMA \"" + stagingSchema + "\"");
                st.execute("SET search_path TO \"" + stagingSchema + "\", public");
            }

            try (Statement st = conn.createStatement()) {
                st.execute(sql);
            } catch (SQLException e) {
                throw new TobeDdlApplyException(
                        "TO-BE DDL 적용 실패 — PG 문법으로 작성되었는지 확인하세요. 원인: "
                                + e.getMessage(), e);
            }

            return buildParsedDdl(conn, stagingSchema);
        } catch (SQLException e) {
            throw new RuntimeException("PgSchemaExtractor connection failed: " + e.getMessage(), e);
        } finally {
            cleanupStagingSchema(stagingSchema);
        }
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
        for (ParsedIndex pi : indexes) loadIndexColumns(conn, schema, pi);

        ParsedDdl result = new ParsedDdl(tables);
        result.setIndexes(indexes);
        result.setConstraints(constraints);
        return result;
    }

    private List<ParsedTable> loadTables(Connection conn, String schema) throws SQLException {
        List<ParsedTable> out = new ArrayList<>();
        try (PreparedStatement ps = conn.prepareStatement(
                "SELECT table_name FROM information_schema.tables "
                        + "WHERE table_schema = ? AND table_type = 'BASE TABLE' "
                        + "ORDER BY table_name")) {
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
        StringBuilder sb = new StringBuilder(dataType);
        if (length != null && length > 0) {
            sb.append("(").append(length).append(")");
        } else if (precision != null && precision > 0) {
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

package com.ksinfo.modernize_pro_data.coordinator.ddl.parser;

import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Oracle DDL ファイルを解析してテーブル/カラム/インデックス/制約情報を抽出する.
 *
 * 対応構文:
 *   - CREATE TABLE (inline UK / FK / CHECK 含む)
 *   - CREATE [UNIQUE | BITMAP] INDEX
 *   - ALTER TABLE ... ADD CONSTRAINT (UK / FK / CHECK)
 *   - COMMENT ON TABLE / COMMENT ON COLUMN
 *   - 行・ブロックコメント
 * 無視: SEQUENCE / TRIGGER / VIEW / STORAGE / TABLESPACE / PARTITION 句, PK の ALTER TABLE (column.pkOrder で表現済).
 * 論理名の優先順位: COMMENT ON COLUMN > CREATE TABLE 内のインラインコメント.
 */
@Component
public class OracleDdlParser {

    private static final Pattern CREATE_TABLE_HEADER = Pattern.compile(
            "^\\s*CREATE\\s+(?:GLOBAL\\s+TEMPORARY\\s+|TEMPORARY\\s+)?TABLE\\s+"
                    + "(?:\"?([\\w$#]+)\"?\\s*\\.\\s*)?\"?([\\w$#]+)\"?\\s*\\(",
            Pattern.CASE_INSENSITIVE);

    private static final Pattern CREATE_INDEX_HEADER = Pattern.compile(
            "^\\s*CREATE\\s+(UNIQUE\\s+|BITMAP\\s+)?INDEX\\s+"
                    + "(?:\"?([\\w$#]+)\"?\\s*\\.\\s*)?\"?([\\w$#]+)\"?\\s+"
                    + "ON\\s+(?:\"?([\\w$#]+)\"?\\s*\\.\\s*)?\"?([\\w$#]+)\"?\\s*\\(",
            Pattern.CASE_INSENSITIVE);

    private static final Pattern ALTER_TABLE_HEADER = Pattern.compile(
            "^\\s*ALTER\\s+TABLE\\s+"
                    + "(?:\"?([\\w$#]+)\"?\\s*\\.\\s*)?\"?([\\w$#]+)\"?\\s+",
            Pattern.CASE_INSENSITIVE);

    private static final Pattern ALTER_ADD_CONSTRAINT = Pattern.compile(
            "(?i)ADD\\s*\\(?\\s*CONSTRAINT\\s+\"?([\\w$#]+)\"?\\s+(.+)$",
            Pattern.DOTALL);

    private static final Pattern INLINE_NAMED_CONSTRAINT = Pattern.compile(
            "(?i)^CONSTRAINT\\s+\"?([\\w$#]+)\"?\\s+(.+)$",
            Pattern.DOTALL);

    private static final Pattern REFERENCES_CLAUSE = Pattern.compile(
            "(?i)REFERENCES\\s+(?:\"?([\\w$#]+)\"?\\s*\\.\\s*)?\"?([\\w$#]+)\"?\\s*\\(([^)]*)\\)",
            Pattern.DOTALL);

    private static final Pattern COMMENT_ON_TABLE = Pattern.compile(
            "^\\s*COMMENT\\s+ON\\s+TABLE\\s+"
                    + "(?:\"?([\\w$#]+)\"?\\s*\\.\\s*)?\"?([\\w$#]+)\"?\\s+IS\\s+'(.*)'\\s*$",
            Pattern.CASE_INSENSITIVE | Pattern.DOTALL);

    private static final Pattern COMMENT_ON_COLUMN = Pattern.compile(
            "^\\s*COMMENT\\s+ON\\s+COLUMN\\s+"
                    + "(?:\"?([\\w$#]+)\"?\\s*\\.\\s*)?\"?([\\w$#]+)\"?\\s*\\.\\s*\"?([\\w$#]+)\"?"
                    + "\\s+IS\\s+'(.*)'\\s*$",
            Pattern.CASE_INSENSITIVE | Pattern.DOTALL);

    private static final Pattern COLUMN_NAME = Pattern.compile(
            "^\"?([\\w$#]+)\"?\\s+(.+)$", Pattern.DOTALL);

    private static final Pattern TYPE_HEAD = Pattern.compile(
            "^([\\w]+)(\\s*\\([^)]*\\))?", Pattern.CASE_INSENSITIVE);

    public ParsedDdl parse(String sql) {
        if (sql == null || sql.isBlank()) return new ParsedDdl(new ArrayList<>());

        List<String> statements = splitStatements(sql);
        List<ParsedTable> tables = new ArrayList<>();
        List<ParsedIndex> indexes = new ArrayList<>();
        List<ParsedConstraint> constraints = new ArrayList<>();
        Map<String, String> tableComments = new HashMap<>();
        Map<String, String> columnComments = new HashMap<>();
        int tableOrdinal = 0;

        for (String stmt : statements) {
            String stripped = stripLeadingCommentsAndWhitespace(stmt);
            if (stripped.isEmpty()) continue;
            String upper = stripped.toUpperCase(Locale.ROOT);
            if (upper.startsWith("CREATE") && upper.contains("TABLE") && !upper.contains("INDEX")) {
                ParsedTable t = parseCreateTable(stripped, tableOrdinal, constraints);
                if (t != null) {
                    tables.add(t);
                    tableOrdinal++;
                }
            } else if (upper.startsWith("CREATE") && upper.contains("INDEX")) {
                ParsedIndex idx = parseCreateIndex(stripped);
                if (idx != null) indexes.add(idx);
            } else if (upper.startsWith("ALTER TABLE")) {
                ParsedConstraint c = parseAlterTableAddConstraint(stripped);
                if (c != null) constraints.add(c);
            } else if (upper.startsWith("COMMENT ON TABLE")) {
                Matcher m = COMMENT_ON_TABLE.matcher(stripped);
                if (m.find()) {
                    tableComments.put(key(m.group(1), m.group(2)), unescape(m.group(3)));
                }
            } else if (upper.startsWith("COMMENT ON COLUMN")) {
                Matcher m = COMMENT_ON_COLUMN.matcher(stripped);
                if (m.find()) {
                    String colKey = key(m.group(1), m.group(2)) + "." + m.group(3).toUpperCase(Locale.ROOT);
                    columnComments.put(colKey, unescape(m.group(4)));
                }
            }
        }

        for (ParsedTable t : tables) {
            String tableKey = key(t.getSchemaName(), t.getPhysicalName());
            String tc = tableComments.get(tableKey);
            if (tc != null) {
                t.setTableComment(tc);
                t.setLogicalName(tc);
            }
            for (ParsedColumn c : t.getColumns()) {
                String colKey = tableKey + "." + c.getPhysicalName().toUpperCase(Locale.ROOT);
                String cc = columnComments.get(colKey);
                if (cc != null) {
                    c.setColumnComment(cc);
                    c.setLogicalName(cc);
                } else if (c.getInlineComment() != null && !c.getInlineComment().isBlank()) {
                    c.setLogicalName(c.getInlineComment());
                }
            }
        }

        ParsedDdl result = new ParsedDdl(tables);
        result.setIndexes(indexes);
        result.setConstraints(constraints);
        return result;
    }

    /** ステートメント先頭の空白/行コメント/ブロックコメントを除去. */
    private String stripLeadingCommentsAndWhitespace(String stmt) {
        int i = 0, len = stmt.length();
        while (i < len) {
            while (i < len && Character.isWhitespace(stmt.charAt(i))) i++;
            if (i >= len) break;
            if (i + 1 < len && stmt.charAt(i) == '-' && stmt.charAt(i + 1) == '-') {
                while (i < len && stmt.charAt(i) != '\n') i++;
                continue;
            }
            if (i + 1 < len && stmt.charAt(i) == '/' && stmt.charAt(i + 1) == '*') {
                i += 2;
                while (i + 1 < len && !(stmt.charAt(i) == '*' && stmt.charAt(i + 1) == '/')) i++;
                i = Math.min(i + 2, len);
                continue;
            }
            break;
        }
        return stmt.substring(i);
    }

    /** 文字列リテラル/コメントを保持しつつ ; で分割. */
    private List<String> splitStatements(String sql) {
        List<String> out = new ArrayList<>();
        StringBuilder sb = new StringBuilder();
        int i = 0, len = sql.length();
        while (i < len) {
            char c = sql.charAt(i);
            if (c == '\'') {
                sb.append(c);
                i++;
                while (i < len) {
                    char d = sql.charAt(i);
                    sb.append(d);
                    i++;
                    if (d == '\'') {
                        if (i < len && sql.charAt(i) == '\'') {
                            sb.append('\'');
                            i++;
                        } else break;
                    }
                }
            } else if (c == '-' && i + 1 < len && sql.charAt(i + 1) == '-') {
                while (i < len && sql.charAt(i) != '\n') {
                    sb.append(sql.charAt(i));
                    i++;
                }
            } else if (c == '/' && i + 1 < len && sql.charAt(i + 1) == '*') {
                sb.append("/*");
                i += 2;
                while (i < len) {
                    if (i + 1 < len && sql.charAt(i) == '*' && sql.charAt(i + 1) == '/') {
                        sb.append("*/");
                        i += 2;
                        break;
                    }
                    sb.append(sql.charAt(i));
                    i++;
                }
            } else if (c == ';') {
                String body = sb.toString().trim();
                if (!body.isEmpty()) out.add(body);
                sb.setLength(0);
                i++;
            } else {
                sb.append(c);
                i++;
            }
        }
        String last = sb.toString().trim();
        if (!last.isEmpty()) out.add(last);
        return out;
    }

    private ParsedTable parseCreateTable(String stmt, int ordinal, List<ParsedConstraint> outConstraints) {
        Matcher m = CREATE_TABLE_HEADER.matcher(stmt);
        if (!m.find()) return null;

        String schemaName = m.group(1) != null ? m.group(1) : "";
        String physicalName = m.group(2);
        int bodyStart = m.end();
        int closeIdx = findMatchingParen(stmt, bodyStart);
        if (closeIdx < 0) return null;
        String body = stmt.substring(bodyStart, closeIdx);

        List<String> parts = splitTopLevel(body, ',');
        ParsedTable table = new ParsedTable();
        table.setSchemaName(schemaName);
        table.setPhysicalName(physicalName);
        table.setOrdinal(ordinal);

        List<String> pkColumns = new ArrayList<>();
        int colOrdinal = 1;
        int inlineConstraintCounter = 0;
        for (String part : parts) {
            String trimmed = part.trim();
            if (trimmed.isEmpty()) continue;
            String upper = trimmed.toUpperCase(Locale.ROOT);

            if (upper.startsWith("CONSTRAINT ")) {
                Matcher nm = INLINE_NAMED_CONSTRAINT.matcher(trimmed);
                if (nm.find()) {
                    String constraintName = nm.group(1);
                    String afterName = nm.group(2).trim();
                    String afterUpper = afterName.toUpperCase(Locale.ROOT);
                    if (afterUpper.startsWith("PRIMARY KEY")) {
                        extractPkColumns(afterName, pkColumns);
                    } else if (afterUpper.startsWith("UNIQUE")) {
                        ParsedConstraint pc = parseUniqueBody(constraintName, schemaName, physicalName, afterName);
                        if (pc != null) outConstraints.add(pc);
                    } else if (afterUpper.startsWith("FOREIGN KEY")) {
                        ParsedConstraint pc = parseForeignKeyBody(constraintName, schemaName, physicalName, afterName);
                        if (pc != null) outConstraints.add(pc);
                    } else if (afterUpper.startsWith("CHECK")) {
                        ParsedConstraint pc = parseCheckBody(constraintName, schemaName, physicalName, afterName);
                        if (pc != null) outConstraints.add(pc);
                    }
                }
                continue;
            }
            if (upper.startsWith("PRIMARY KEY")) {
                extractPkColumns(trimmed, pkColumns);
                continue;
            }
            if (upper.startsWith("UNIQUE")) {
                inlineConstraintCounter++;
                String autoName = "uq_" + physicalName.toLowerCase(Locale.ROOT) + "_" + inlineConstraintCounter;
                ParsedConstraint pc = parseUniqueBody(autoName, schemaName, physicalName, trimmed);
                if (pc != null) outConstraints.add(pc);
                continue;
            }
            if (upper.startsWith("FOREIGN KEY")) {
                inlineConstraintCounter++;
                String autoName = "fk_" + physicalName.toLowerCase(Locale.ROOT) + "_" + inlineConstraintCounter;
                ParsedConstraint pc = parseForeignKeyBody(autoName, schemaName, physicalName, trimmed);
                if (pc != null) outConstraints.add(pc);
                continue;
            }
            if (upper.startsWith("CHECK")) {
                inlineConstraintCounter++;
                String autoName = "ck_" + physicalName.toLowerCase(Locale.ROOT) + "_" + inlineConstraintCounter;
                ParsedConstraint pc = parseCheckBody(autoName, schemaName, physicalName, trimmed);
                if (pc != null) outConstraints.add(pc);
                continue;
            }
            if (upper.startsWith("PARTITION ")) continue;

            ParsedColumn col = parseColumnDef(trimmed, colOrdinal);
            if (col != null) {
                table.getColumns().add(col);
                colOrdinal++;
            }
        }

        for (int idx = 0; idx < pkColumns.size(); idx++) {
            String pk = pkColumns.get(idx).toUpperCase(Locale.ROOT);
            int order = idx + 1;
            for (ParsedColumn c : table.getColumns()) {
                if (c.getPhysicalName().toUpperCase(Locale.ROOT).equals(pk)) {
                    c.setPkOrder(order);
                    c.setNullable(false);
                    break;
                }
            }
        }
        return table;
    }

    /** {@code UNIQUE (col, ...)} 형식 fragment 를 파싱. */
    private ParsedConstraint parseUniqueBody(String name, String schema, String table, String fragment) {
        int open = fragment.indexOf('(');
        if (open < 0) return null;
        int close = findMatchingParen(fragment, open + 1);
        if (close < 0) return null;
        String inside = fragment.substring(open + 1, close);

        ParsedConstraint pc = new ParsedConstraint();
        pc.setName(name);
        pc.setSchemaName(schema);
        pc.setTableName(table);
        pc.setType(ParsedConstraint.TYPE_UK);

        int ord = 1;
        for (String s : inside.split(",")) {
            String col = s.trim().replaceAll("^\"|\"$", "");
            if (col.isEmpty()) continue;
            ParsedConstraintColumn cc = new ParsedConstraintColumn();
            cc.setOrdinal(ord++);
            cc.setColumnName(col);
            pc.getColumns().add(cc);
        }
        return pc.getColumns().isEmpty() ? null : pc;
    }

    /** {@code FOREIGN KEY (cols) REFERENCES ref(cols) [ON DELETE ...] [DEFERRABLE ...]} 형식 파싱. */
    private ParsedConstraint parseForeignKeyBody(String name, String schema, String table, String fragment) {
        int open = fragment.indexOf('(');
        if (open < 0) return null;
        int close = findMatchingParen(fragment, open + 1);
        if (close < 0) return null;
        String childCols = fragment.substring(open + 1, close);
        String afterCols = fragment.substring(close + 1);

        Matcher rm = REFERENCES_CLAUSE.matcher(afterCols);
        if (!rm.find()) return null;
        String refSchema = rm.group(1) == null ? "" : rm.group(1);
        String refTable = rm.group(2);
        String refCols = rm.group(3);
        String afterRef = afterCols.substring(rm.end()).toUpperCase(Locale.ROOT);

        ParsedConstraint pc = new ParsedConstraint();
        pc.setName(name);
        pc.setSchemaName(schema);
        pc.setTableName(table);
        pc.setType(ParsedConstraint.TYPE_FK);

        ParsedForeignKey fk = new ParsedForeignKey();
        fk.setRefSchemaName(refSchema);
        fk.setRefTableName(refTable);
        fk.setOnDelete(extractAction(afterRef, "ON\\s+DELETE"));
        fk.setOnUpdate(extractAction(afterRef, "ON\\s+UPDATE"));
        if (afterRef.matches("(?s).*\\bDEFERRABLE\\b.*")) {
            String def = afterRef.contains("INITIALLY DEFERRED")
                    ? "DEFERRABLE INITIALLY DEFERRED"
                    : (afterRef.contains("INITIALLY IMMEDIATE")
                        ? "DEFERRABLE INITIALLY IMMEDIATE"
                        : "DEFERRABLE");
            fk.setDeferrableInfo(def);
        }
        pc.setForeignKey(fk);

        String[] childArr = childCols.split(",");
        String[] refArr = refCols.split(",");
        for (int i = 0; i < childArr.length; i++) {
            String childCol = childArr[i].trim().replaceAll("^\"|\"$", "");
            String refCol = i < refArr.length ? refArr[i].trim().replaceAll("^\"|\"$", "") : null;
            if (childCol.isEmpty()) continue;
            ParsedConstraintColumn cc = new ParsedConstraintColumn();
            cc.setOrdinal(i + 1);
            cc.setColumnName(childCol);
            cc.setRefColumnName(refCol);
            pc.getColumns().add(cc);
        }
        return pc.getColumns().isEmpty() ? null : pc;
    }

    /** {@code CHECK (expr)} fragment 파싱. */
    private ParsedConstraint parseCheckBody(String name, String schema, String table, String fragment) {
        int open = fragment.indexOf('(');
        if (open < 0) return null;
        int close = findMatchingParen(fragment, open + 1);
        if (close < 0) return null;
        String expr = fragment.substring(open + 1, close).trim();

        ParsedConstraint pc = new ParsedConstraint();
        pc.setName(name);
        pc.setSchemaName(schema);
        pc.setTableName(table);
        pc.setType(ParsedConstraint.TYPE_CHECK);
        pc.setCheckExpression(expr);
        return pc;
    }

    private String extractAction(String afterUpper, String prefix) {
        Matcher am = Pattern.compile("(?i)" + prefix + "\\s+(CASCADE|SET\\s+NULL|SET\\s+DEFAULT|RESTRICT|NO\\s+ACTION)").matcher(afterUpper);
        if (am.find()) {
            String raw = am.group(1).toUpperCase(Locale.ROOT).replaceAll("\\s+", " ");
            return raw;
        }
        return "NO ACTION";
    }

    /** {@code CREATE [UNIQUE | BITMAP] INDEX} 구문 파싱. */
    private ParsedIndex parseCreateIndex(String stmt) {
        Matcher m = CREATE_INDEX_HEADER.matcher(stmt);
        if (!m.find()) return null;

        String modifier = m.group(1) == null ? "" : m.group(1).trim().toUpperCase(Locale.ROOT);
        String indexName = m.group(3);
        String tableSchema = m.group(4) == null ? "" : m.group(4);
        String tableName = m.group(5);
        int bodyStart = m.end();
        int closeIdx = findMatchingParen(stmt, bodyStart);
        if (closeIdx < 0) return null;
        String columnsBody = stmt.substring(bodyStart, closeIdx);

        ParsedIndex pi = new ParsedIndex();
        pi.setName(indexName);
        pi.setSchemaName(tableSchema);
        pi.setTableName(tableName);
        pi.setUnique(modifier.startsWith("UNIQUE"));
        if (modifier.startsWith("BITMAP")) pi.setType("bitmap");
        else pi.setType("btree");

        List<String> cols = splitTopLevel(columnsBody, ',');
        int ord = 1;
        boolean hasExpression = false;
        StringBuilder exprBuilder = new StringBuilder();
        for (String c : cols) {
            String t = c.trim();
            if (t.isEmpty()) continue;
            if (t.contains("(")) {
                hasExpression = true;
                if (exprBuilder.length() > 0) exprBuilder.append(", ");
                exprBuilder.append(t);
                continue;
            }
            String[] tokens = t.split("\\s+");
            ParsedIndexColumn ic = new ParsedIndexColumn();
            ic.setOrdinal(ord++);
            ic.setColumnName(tokens[0].replaceAll("^\"|\"$", ""));
            if (tokens.length > 1) {
                String dir = tokens[1].toUpperCase(Locale.ROOT);
                if (dir.equals("ASC") || dir.equals("DESC")) ic.setSortOrder(dir);
            }
            pi.getColumns().add(ic);
        }
        if (hasExpression) {
            pi.setType("functional");
            pi.setExpression(exprBuilder.toString());
        }

        String after = stmt.substring(closeIdx + 1).toUpperCase(Locale.ROOT);
        if (after.matches("(?s).*\\bREVERSE\\b.*")) pi.setType("reverse");

        return pi;
    }

    /** {@code ALTER TABLE ... ADD CONSTRAINT ...} 구문 파싱. PK 는 무시 (column.pk_order 가 표현). */
    private ParsedConstraint parseAlterTableAddConstraint(String stmt) {
        Matcher m = ALTER_TABLE_HEADER.matcher(stmt);
        if (!m.find()) return null;
        String tableSchema = m.group(1) == null ? "" : m.group(1);
        String tableName = m.group(2);
        String rest = stmt.substring(m.end()).trim();

        Matcher addM = ALTER_ADD_CONSTRAINT.matcher(rest);
        if (!addM.find()) return null;
        String constraintName = addM.group(1);
        String body = addM.group(2).trim();

        String upperBody = body.toUpperCase(Locale.ROOT);
        if (upperBody.startsWith("UNIQUE")) {
            return parseUniqueBody(constraintName, tableSchema, tableName, body);
        } else if (upperBody.startsWith("FOREIGN KEY")) {
            return parseForeignKeyBody(constraintName, tableSchema, tableName, body);
        } else if (upperBody.startsWith("CHECK")) {
            return parseCheckBody(constraintName, tableSchema, tableName, body);
        }
        return null;
    }

    private int findMatchingParen(String s, int afterOpenIdx) {
        int depth = 1;
        int i = afterOpenIdx;
        int len = s.length();
        while (i < len && depth > 0) {
            char c = s.charAt(i);
            if (c == '\'') {
                i++;
                while (i < len) {
                    char d = s.charAt(i);
                    i++;
                    if (d == '\'') {
                        if (i < len && s.charAt(i) == '\'') i++;
                        else break;
                    }
                }
            } else if (c == '-' && i + 1 < len && s.charAt(i + 1) == '-') {
                while (i < len && s.charAt(i) != '\n') i++;
            } else if (c == '/' && i + 1 < len && s.charAt(i + 1) == '*') {
                i += 2;
                while (i + 1 < len && !(s.charAt(i) == '*' && s.charAt(i + 1) == '/')) i++;
                i += 2;
            } else if (c == '(') {
                depth++;
                i++;
            } else if (c == ')') {
                depth--;
                if (depth == 0) return i;
                i++;
            } else {
                i++;
            }
        }
        return -1;
    }

    private List<String> splitTopLevel(String body, char sep) {
        List<String> out = new ArrayList<>();
        StringBuilder sb = new StringBuilder();
        int depth = 0;
        int i = 0, len = body.length();
        while (i < len) {
            char c = body.charAt(i);
            if (c == '\'') {
                sb.append(c);
                i++;
                while (i < len) {
                    char d = body.charAt(i);
                    sb.append(d);
                    i++;
                    if (d == '\'') {
                        if (i < len && body.charAt(i) == '\'') {
                            sb.append('\'');
                            i++;
                        } else break;
                    }
                }
            } else if (c == '(') {
                depth++;
                sb.append(c);
                i++;
            } else if (c == ')') {
                depth--;
                sb.append(c);
                i++;
            } else if (c == sep && depth == 0) {
                int j = i + 1;
                while (j < len && (body.charAt(j) == ' ' || body.charAt(j) == '\t')) j++;
                if (j + 1 < len && body.charAt(j) == '-' && body.charAt(j + 1) == '-') {
                    while (j < len && body.charAt(j) != '\n') {
                        sb.append(body.charAt(j));
                        j++;
                    }
                    out.add(sb.toString());
                    sb.setLength(0);
                    i = j;
                } else {
                    out.add(sb.toString());
                    sb.setLength(0);
                    i++;
                }
            } else {
                sb.append(c);
                i++;
            }
        }
        if (sb.length() > 0) out.add(sb.toString());
        return out;
    }

    private void extractPkColumns(String fragment, List<String> pkColumns) {
        int open = fragment.indexOf('(');
        if (open < 0) return;
        int close = findMatchingParen(fragment, open + 1);
        if (close < 0) return;
        String inside = fragment.substring(open + 1, close);
        for (String s : inside.split(",")) {
            String name = s.trim().replaceAll("^\"|\"$", "");
            if (!name.isEmpty()) pkColumns.add(name);
        }
    }

    private ParsedColumn parseColumnDef(String def, int ordinal) {
        StringBuilder cleaned = new StringBuilder();
        StringBuilder comments = new StringBuilder();
        int i = 0, len = def.length();
        while (i < len) {
            char c = def.charAt(i);
            if (c == '\'') {
                cleaned.append(c);
                i++;
                while (i < len) {
                    char d = def.charAt(i);
                    cleaned.append(d);
                    i++;
                    if (d == '\'') {
                        if (i < len && def.charAt(i) == '\'') {
                            cleaned.append('\'');
                            i++;
                        } else break;
                    }
                }
            } else if (c == '-' && i + 1 < len && def.charAt(i + 1) == '-') {
                i += 2;
                StringBuilder cm = new StringBuilder();
                while (i < len && def.charAt(i) != '\n') {
                    cm.append(def.charAt(i));
                    i++;
                }
                appendComment(comments, cm.toString());
            } else if (c == '/' && i + 1 < len && def.charAt(i + 1) == '*') {
                i += 2;
                StringBuilder cm = new StringBuilder();
                while (i < len) {
                    if (i + 1 < len && def.charAt(i) == '*' && def.charAt(i + 1) == '/') {
                        i += 2;
                        break;
                    }
                    cm.append(def.charAt(i));
                    i++;
                }
                appendComment(comments, cm.toString());
            } else {
                cleaned.append(c);
                i++;
            }
        }
        String src = cleaned.toString().trim();
        if (src.isEmpty()) return null;

        Matcher cm = COLUMN_NAME.matcher(src);
        if (!cm.find()) return null;
        String colName = cm.group(1);
        String rest = cm.group(2).trim();

        Matcher tm = TYPE_HEAD.matcher(rest);
        if (!tm.find()) return null;
        String typeName = tm.group(1);
        String typeArgs = tm.group(2) == null ? "" : tm.group(2);
        String dataTypeRaw = (typeName + typeArgs).trim();
        String dataType = typeName.toUpperCase(Locale.ROOT);
        String afterType = rest.substring(tm.end()).trim();

        Integer length = null, precision = null, scale = null;
        if (!typeArgs.isEmpty()) {
            String inside = typeArgs.replaceAll("[()]", "").trim();
            inside = inside.replaceAll("(?i)\\s+(BYTE|CHAR)\\s*$", "");
            String[] argParts = inside.split(",");
            try {
                if (argParts.length == 1) {
                    String v = argParts[0].trim();
                    if (!v.equals("*") && !v.isEmpty()) {
                        int n = Integer.parseInt(v);
                        if (isNumericType(dataType)) precision = n;
                        else if (isDateTimeType(dataType)) precision = n;
                        else length = n;
                    }
                } else if (argParts.length == 2) {
                    String p = argParts[0].trim();
                    String s = argParts[1].trim();
                    if (!p.equals("*") && !p.isEmpty()) precision = Integer.parseInt(p);
                    if (!s.isEmpty()) scale = Integer.parseInt(s);
                }
            } catch (NumberFormatException ignored) {
                // best effort
            }
        }

        boolean nullable = true;
        Integer pkOrder = null;
        String defaultValue = null;

        Matcher defaultM = Pattern.compile(
                "DEFAULT\\s+(.+?)(?=\\s+(?:NOT\\s+NULL|NULL|PRIMARY\\s+KEY|UNIQUE|CHECK|CONSTRAINT|ENABLE|DISABLE)\\b|$)",
                Pattern.CASE_INSENSITIVE | Pattern.DOTALL).matcher(afterType);
        if (defaultM.find()) {
            defaultValue = defaultM.group(1).trim();
            if (defaultValue.endsWith(",")) {
                defaultValue = defaultValue.substring(0, defaultValue.length() - 1).trim();
            }
        }

        String afterUpper = afterType.toUpperCase(Locale.ROOT);
        if (afterUpper.matches("(?s).*\\bNOT\\s+NULL\\b.*")) nullable = false;
        if (afterUpper.matches("(?s).*\\bPRIMARY\\s+KEY\\b.*")) {
            pkOrder = 1;
            nullable = false;
        }

        ParsedColumn col = new ParsedColumn();
        col.setOrdinal(ordinal);
        col.setPhysicalName(colName);
        col.setDataTypeRaw(dataTypeRaw);
        col.setDataType(dataType);
        col.setLength(length);
        col.setPrecision(precision);
        col.setScale(scale);
        col.setNullable(nullable);
        col.setPkOrder(pkOrder);
        col.setDefaultValue(defaultValue);
        col.setInlineComment(comments.length() == 0 ? null : comments.toString().trim());
        return col;
    }

    private boolean isNumericType(String dataType) {
        return dataType.equals("NUMBER") || dataType.equals("FLOAT")
                || dataType.equals("INTEGER") || dataType.equals("INT")
                || dataType.equals("DECIMAL") || dataType.equals("NUMERIC")
                || dataType.equals("SMALLINT") || dataType.equals("BIGINT");
    }

    /** TIMESTAMP(n) / TIME(n) 류 — (n) 은 fractional-second precision 으로 저장. */
    private boolean isDateTimeType(String dataType) {
        return dataType.startsWith("TIMESTAMP") || dataType.equals("TIME")
                || dataType.startsWith("INTERVAL");
    }

    private void appendComment(StringBuilder sb, String comment) {
        String t = comment.trim();
        if (t.isEmpty()) return;
        if (sb.length() > 0) sb.append(' ');
        sb.append(t);
    }

    private String key(String schema, String table) {
        String s = schema == null ? "" : schema.toUpperCase(Locale.ROOT);
        return s + "." + table.toUpperCase(Locale.ROOT);
    }

    private String unescape(String s) {
        return s == null ? "" : s.replace("''", "'");
    }
}

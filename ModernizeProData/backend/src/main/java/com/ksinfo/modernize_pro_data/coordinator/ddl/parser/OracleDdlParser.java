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
 * Oracle DDL ファイルを解析してテーブル/カラム情報を抽出する.
 *
 * 対応構文: CREATE TABLE / COMMENT ON TABLE / COMMENT ON COLUMN / 行・ブロックコメント.
 * 無視: FK / INDEX / SEQUENCE / TRIGGER / VIEW / STORAGE / TABLESPACE / PARTITION 句.
 * 論理名の優先順位: COMMENT ON COLUMN > CREATE TABLE 内のインラインコメント.
 */
@Component
public class OracleDdlParser {

    private static final Pattern CREATE_TABLE_HEADER = Pattern.compile(
            "^\\s*CREATE\\s+(?:GLOBAL\\s+TEMPORARY\\s+|TEMPORARY\\s+)?TABLE\\s+"
                    + "(?:\"?([\\w$#]+)\"?\\s*\\.\\s*)?\"?([\\w$#]+)\"?\\s*\\(",
            Pattern.CASE_INSENSITIVE);

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
        Map<String, String> tableComments = new HashMap<>();
        Map<String, String> columnComments = new HashMap<>();
        int tableOrdinal = 0;

        for (String stmt : statements) {
            String stripped = stripLeadingCommentsAndWhitespace(stmt);
            if (stripped.isEmpty()) continue;
            String upper = stripped.toUpperCase(Locale.ROOT);
            if (upper.startsWith("CREATE") && upper.contains("TABLE")) {
                ParsedTable t = parseCreateTable(stripped, tableOrdinal);
                if (t != null) {
                    tables.add(t);
                    tableOrdinal++;
                }
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

        return new ParsedDdl(tables);
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

    private ParsedTable parseCreateTable(String stmt, int ordinal) {
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
        for (String part : parts) {
            String trimmed = part.trim();
            if (trimmed.isEmpty()) continue;
            String upper = trimmed.toUpperCase(Locale.ROOT);

            if (upper.startsWith("CONSTRAINT ")) {
                String afterName = trimmed.replaceFirst("(?i)^CONSTRAINT\\s+\"?[\\w$#]+\"?\\s*", "");
                if (afterName.toUpperCase(Locale.ROOT).startsWith("PRIMARY KEY")) {
                    extractPkColumns(afterName, pkColumns);
                }
                continue;
            }
            if (upper.startsWith("PRIMARY KEY")) {
                extractPkColumns(trimmed, pkColumns);
                continue;
            }
            if (upper.startsWith("UNIQUE") || upper.startsWith("FOREIGN KEY")
                    || upper.startsWith("CHECK") || upper.startsWith("PARTITION ")) {
                continue;
            }

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
                // `,` 直後の同一行コメント (`-- xxx`) は前のカラムの行末コメントとみなし, sb に取り込んでから分割.
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
        // コメントを分離し、論理名候補として保持
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
                        /* 숫자형 → precision, 시간형(TIMESTAMP(n) / TIME(n)) → fractional-second precision,
                         * 그 외(VARCHAR/CHAR/RAW 등) → 문자 길이. TIMESTAMP(6) 의 6 을 length 로 저장하면
                         * audit length 체크가 모든 timestamp 문자열을 위반으로 잘못 판정한다. */
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

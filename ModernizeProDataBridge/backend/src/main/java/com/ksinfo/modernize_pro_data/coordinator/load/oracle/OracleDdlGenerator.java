package com.ksinfo.modernize_pro_data.coordinator.load.oracle;

import com.ksinfo.modernize_pro_data.coordinator.ddl.DdlColumn;

import java.util.Comparator;
import java.util.List;
import java.util.stream.Collectors;

/**
 * TO-BE DDL 메타 → Oracle CREATE TABLE / 제약 SQL 생성 ({@link com.ksinfo.modernize_pro_data.coordinator.load.PgDdlGenerator} 의 Oracle 판).
 *
 * <p>PG 대비 Oracle 특유 처리(계획서 R4/R5):
 * <ul>
 *   <li><b>quote-everywhere</b>(R4): 식별자 항상 {@code "X"} — unquoted→UPPER 폴딩 회피.</li>
 *   <li><b>멀티바이트 안전 사이징</b>(R5): 문자형은 항상 <b>CHAR 길이 의미</b>({@code VARCHAR2(n CHAR)}) —
 *       JA16SJIS/JA16EUC 저장 시 byte 기준이면 절반 길이에서 잘리므로. targetCharset 무관하게 CHAR 로 안전.</li>
 *   <li><b>멱등</b>: Oracle 은 {@code CREATE TABLE IF NOT EXISTS} 부재 → PL/SQL 블록으로 ORA-00955(이미 존재)
 *       무시(LoadStage.ensureTable 이 try/catch 안 함). PK/UK/FK/CHECK 는 caller 가 catch → plain ALTER.</li>
 *   <li><b>BOOLEAN 부재</b>(pre-23c): {@code NUMBER(1)} 매핑.</li>
 *   <li><b>FK</b>: Oracle 은 {@code ON UPDATE} 없음(생략), {@code ON DELETE} 는 CASCADE/SET NULL 만,
 *       "NOT VALID" 대신 {@code ENABLE NOVALIDATE}.</li>
 * </ul>
 *
 * <p><b>전제</b>: schema(=owner)는 DBA 가 사전 provisioning (폐쇄망 운영 모델). {@link #createSchemaIfNotExists}
 * 는 no-op — Oracle 에서 CREATE USER 는 권한/테이블스페이스/비밀번호가 필요해 도구가 임의 생성하지 않는다.
 */
public final class OracleDdlGenerator {

    private OracleDdlGenerator() {}

    /** Oracle schema=owner 는 사전 생성 전제 → 무해한 no-op PL/SQL. */
    public static String createSchemaIfNotExists(String schema) {
        return "BEGIN NULL; END;";
    }

    /** CREATE TABLE (inline PK 없음 — 적재 후 부착) 을 ORA-00955 무시 PL/SQL 로 감싸 멱등화. */
    public static String createTableIfNotExists(String schema, String table, List<DdlColumn> cols,
                                                String targetCharset) {
        StringBuilder inner = new StringBuilder("CREATE TABLE ")
                .append(qualifiedTable(schema, table)).append(" (");
        for (int i = 0; i < cols.size(); i++) {
            DdlColumn c = cols.get(i);
            inner.append(ident(c.getPhysicalName())).append(" ").append(toOracleType(c));
            if (!c.isNullable()) inner.append(" NOT NULL");
            if (i < cols.size() - 1) inner.append(", ");
        }
        inner.append(")");
        return plsqlIgnore(inner.toString(), 955);
    }

    public static List<String> primaryKeyColumns(List<DdlColumn> cols) {
        return cols.stream()
                .filter(c -> c.getPkOrder() != null)
                .sorted(Comparator.comparing(DdlColumn::getPkOrder))
                .map(DdlColumn::getPhysicalName)
                .toList();
    }

    public static String addPrimaryKeySql(String schema, String table, List<String> pkColumns) {
        String cols = pkColumns.stream().map(OracleDdlGenerator::ident).collect(Collectors.joining(", "));
        return "ALTER TABLE " + qualifiedTable(schema, table) + " ADD PRIMARY KEY (" + cols + ")";
    }

    public static String addUniqueConstraintSql(String schema, String table,
                                                String constraintName, List<String> columns) {
        String cols = columns.stream().map(OracleDdlGenerator::ident).collect(Collectors.joining(", "));
        return "ALTER TABLE " + qualifiedTable(schema, table)
                + " ADD CONSTRAINT " + ident(constraintName) + " UNIQUE (" + cols + ")";
    }

    /**
     * Oracle FK — {@code ON UPDATE} 미지원(무시), {@code ON DELETE} 는 CASCADE/SET NULL 만, {@code ENABLE NOVALIDATE}
     * (기존 row 검증 skip, 신규 강제 — PG 의 NOT VALID 대응). deferrableInfo 는 ENABLE 앞에 배치.
     */
    public static String addForeignKeyNotValidSql(String schema, String table, String fkName,
                                                  List<String> columns,
                                                  String refSchema, String refTable, List<String> refColumns,
                                                  String onDelete, String onUpdate, String deferrableInfo) {
        String cols = columns.stream().map(OracleDdlGenerator::ident).collect(Collectors.joining(", "));
        String refCols = refColumns.stream().map(OracleDdlGenerator::ident).collect(Collectors.joining(", "));
        StringBuilder sb = new StringBuilder();
        sb.append("ALTER TABLE ").append(qualifiedTable(schema, table))
                .append(" ADD CONSTRAINT ").append(ident(fkName))
                .append(" FOREIGN KEY (").append(cols).append(")")
                .append(" REFERENCES ").append(qualifiedTable(refSchema, refTable))
                .append(" (").append(refCols).append(")");
        if (onDelete != null && !onDelete.isBlank()) {
            String od = onDelete.trim().toUpperCase();
            // Oracle 은 CASCADE / SET NULL 만 (RESTRICT/NO ACTION 은 기본 동작 = 절 생략).
            if (od.equals("CASCADE") || od.equals("SET NULL")) {
                sb.append(" ON DELETE ").append(od);
            }
        }
        // onUpdate: Oracle 미지원 → 의도적으로 무시.
        if (deferrableInfo != null && !deferrableInfo.isBlank()) {
            sb.append(" ").append(deferrableInfo.trim().toUpperCase());
        }
        sb.append(" ENABLE NOVALIDATE");
        return sb.toString();
    }

    /** Oracle: NOVALIDATE 로 붙인 제약의 기존 데이터 검증. */
    public static String validateForeignKeySql(String schema, String table, String fkName) {
        return "ALTER TABLE " + qualifiedTable(schema, table) + " ENABLE VALIDATE CONSTRAINT " + ident(fkName);
    }

    public static String addCheckConstraintNotValidSql(String schema, String table,
                                                       String constraintName, String checkExpression) {
        return "ALTER TABLE " + qualifiedTable(schema, table)
                + " ADD CONSTRAINT " + ident(constraintName)
                + " CHECK (" + checkExpression + ") ENABLE NOVALIDATE";
    }

    public static String validateCheckConstraintSql(String schema, String table, String constraintName) {
        return "ALTER TABLE " + qualifiedTable(schema, table)
                + " ENABLE VALIDATE CONSTRAINT " + ident(constraintName);
    }

    /* ---------- 타입 매핑 ---------- */

    /** TO-BE 타입 → Oracle 타입. 문자형은 CHAR 길이 의미(멀티바이트 안전). 알 수 없으면 raw pass-through. */
    static String toOracleType(DdlColumn c) {
        String dt = c.getDataType() == null ? "" : c.getDataType().toUpperCase().trim();
        Integer len = c.getLength();
        Integer p = c.getPrecision();
        Integer s = c.getScale();

        switch (dt) {
            case "VARCHAR2":
            case "NVARCHAR2":
            case "VARCHAR":
            case "CHARACTER VARYING":
            case "STRING": {
                int n = (len != null && len > 0) ? len : 4000;
                if (n > 4000) return "CLOB";
                return "VARCHAR2(" + n + " CHAR)";
            }
            case "CHAR":
            case "NCHAR":
            case "BPCHAR":
            case "CHARACTER": {
                int n = (len != null && len > 0) ? len : 1;
                if (n > 2000) return "VARCHAR2(4000 CHAR)";
                return "CHAR(" + n + " CHAR)";
            }
            case "NUMBER":
            case "NUMERIC":
            case "DECIMAL":
                if (p != null && p > 0) {
                    if (s != null && s > 0) return "NUMBER(" + p + "," + s + ")";
                    return "NUMBER(" + p + ")";
                }
                return "NUMBER";
            case "INT":
            case "INTEGER":
            case "INT4":
                return "NUMBER(10)";
            case "BIGINT":
            case "INT8":
                return "NUMBER(19)";
            case "SMALLINT":
            case "INT2":
                return "NUMBER(5)";
            case "BOOLEAN":
            case "BOOL":
            case "BIT":
                // Oracle pre-23c 는 BOOLEAN 컬럼 타입 없음 → 0/1 NUMBER(1).
                return "NUMBER(1)";
            case "FLOAT":
            case "DOUBLE":
            case "DOUBLE PRECISION":
            case "FLOAT8":
            case "BINARY_DOUBLE":
                return "BINARY_DOUBLE";
            case "REAL":
            case "FLOAT4":
            case "BINARY_FLOAT":
                return "BINARY_FLOAT";
            case "DATE":
                return "DATE";
            case "TIMESTAMP":
                if (p != null && p >= 0 && p <= 9) return "TIMESTAMP(" + p + ")";
                return "TIMESTAMP";
            case "TIMESTAMPTZ":
            case "TIMESTAMP WITH TIME ZONE":
                return "TIMESTAMP WITH TIME ZONE";
            case "CLOB":
            case "NCLOB":
            case "LONG":
            case "TEXT":
                return "CLOB";
            case "BLOB":
            case "BYTEA":
            case "RAW":
            case "LONG RAW":
                return "BLOB";
            case "UUID":
                return "VARCHAR2(36 CHAR)";
            case "JSON":
            case "JSONB":
                return "CLOB";
            default:
                String raw = c.getDataTypeRaw();
                return raw != null && !raw.isBlank() ? raw : dt;
        }
    }

    /* ---------- helpers ---------- */

    private static String plsqlIgnore(String ddl, int... ignoredOraCodes) {
        String cond = java.util.Arrays.stream(ignoredOraCodes)
                .mapToObj(code -> "SQLCODE != -" + code)
                .collect(Collectors.joining(" AND "));
        return "BEGIN EXECUTE IMMEDIATE '" + ddl.replace("'", "''")
                + "'; EXCEPTION WHEN OTHERS THEN IF " + cond + " THEN RAISE; END IF; END;";
    }

    static String ident(String name) {
        return "\"" + name.replace("\"", "\"\"") + "\"";
    }

    public static String qualifiedTable(String schema, String table) {
        if (schema == null || schema.isBlank()) return ident(table);
        return ident(schema) + "." + ident(table);
    }
}

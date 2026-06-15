package com.ksinfo.modernize_pro_data.coordinator.load;

import com.ksinfo.modernize_pro_data.coordinator.ddl.DdlColumn;

import java.util.Comparator;
import java.util.List;
import java.util.stream.Collectors;

/**
 * TO-BE DDL 메타 → PostgreSQL CREATE TABLE/SCHEMA SQL 생성.
 *
 * PoC1 부트스트랩 — Load 직전에 LoadStage 가 호출해 target PG 에 schema·table 이
 * 없으면 자동 생성한다 ({@code IF NOT EXISTS} 이므로 idempotent). DBA 가 미리
 * Migration SQL 을 적용해두면 NO-OP. PoC2 에선 별도 migration tooling 으로 대체.
 *
 * 타입 변환은 Oracle (현재 유일한 DDL parser) → PG 매핑이 핵심:
 *   - VARCHAR2 → VARCHAR, NVARCHAR2 → VARCHAR
 *   - NCHAR → CHAR
 *   - NUMBER(p,s) → NUMERIC(p,s), NUMBER(p,0)/NUMBER(p) → NUMERIC(p), NUMBER → NUMERIC
 *   - CLOB / NCLOB / LONG → TEXT
 *   - BLOB / RAW / LONG RAW → BYTEA
 *   - BINARY_FLOAT → REAL, BINARY_DOUBLE/FLOAT → DOUBLE PRECISION
 *   - DATE → DATE (date-only 의미로 다룸; 시각 정보 필요하면 TO-BE DDL 에서 TIMESTAMP 사용)
 *   - 그 외 (VARCHAR, CHAR, DATE, TIMESTAMP, BOOLEAN 등 PG-native) → pass-through
 */
public final class PgDdlGenerator {

    private PgDdlGenerator() {}

    public static String createSchemaIfNotExists(String schema) {
        return "CREATE SCHEMA IF NOT EXISTS " + ident(schema);
    }

    /**
     * 컬럼 metadata 로부터 {@code CREATE TABLE IF NOT EXISTS schema.table (...)} SQL 생성.
     * 컬럼은 ordinal 순. PK 컬럼이 있으면 {@code PRIMARY KEY (...)} 추가.
     */
    public static String createTableIfNotExists(String schema, String table, List<DdlColumn> cols) {
        StringBuilder sb = new StringBuilder();
        sb.append("CREATE TABLE IF NOT EXISTS ");
        if (schema != null && !schema.isBlank()) sb.append(ident(schema)).append(".");
        sb.append(ident(table)).append(" (\n");

        for (int i = 0; i < cols.size(); i++) {
            DdlColumn c = cols.get(i);
            sb.append("  ").append(ident(c.getPhysicalName())).append(" ").append(toPgType(c));
            if (!c.isNullable()) sb.append(" NOT NULL");
            if (i < cols.size() - 1) sb.append(",");
            sb.append("\n");
        }

        // PRIMARY KEY (pk_order 가 있는 컬럼들, 순서대로)
        List<String> pkCols = cols.stream()
                .filter(c -> c.getPkOrder() != null)
                .sorted(Comparator.comparing(DdlColumn::getPkOrder))
                .map(c -> ident(c.getPhysicalName()))
                .toList();
        if (!pkCols.isEmpty()) {
            // 위 마지막 컬럼 라인에 trailing newline 만 들어가있고 comma 없음 → 추가 comma 필요
            // 위 loop 의 i<size-1 분기로 마지막 컬럼 뒤 comma 가 없어서, 여기 직전에 comma 삽입.
            int last = sb.lastIndexOf("\n");
            sb.insert(last, ",");
            sb.append("  PRIMARY KEY (").append(String.join(", ", pkCols)).append(")\n");
        }

        sb.append(")");
        return sb.toString();
    }

    /** Oracle → PG 타입 매핑. length/precision/scale 동봉. 알 수 없는 타입은 pass-through. */
    static String toPgType(DdlColumn c) {
        String dt = c.getDataType() == null ? "" : c.getDataType().toUpperCase().trim();
        Integer len = c.getLength();
        Integer p = c.getPrecision();
        Integer s = c.getScale();

        switch (dt) {
            case "VARCHAR2":
            case "NVARCHAR2":
                return "VARCHAR" + (len != null && len > 0 ? "(" + len + ")" : "");
            case "VARCHAR":
                return "VARCHAR" + (len != null && len > 0 ? "(" + len + ")" : "");
            case "NCHAR":
            case "CHAR":
                return "CHAR" + (len != null && len > 0 ? "(" + len + ")" : "");
            case "NUMBER":
            case "NUMERIC":
            case "DECIMAL":
                if (p != null && p > 0) {
                    if (s != null && s > 0) return "NUMERIC(" + p + "," + s + ")";
                    return "NUMERIC(" + p + ")";
                }
                return "NUMERIC";
            case "INT":
            case "INTEGER":
            case "INT4":
                return "INTEGER";
            case "BIGINT":
            case "INT8":
                // PG 내부 타입명 int8 = bigint. 정수형엔 수정자(precision) 안 붙인다 — TO-BE DDL 을
                // PgSchemaExtractor 가 udt_name(int8)+numeric_precision(64bit)로 캡처해 "INT8(64)" 가
                // 되면, 그대로 발급 시 CREATE TABLE 이 "type modifier is not allowed for type int8" 로
                // 실패하던 버그. canonical 'BIGINT'(modifier 없음)로 발급해 해소.
                return "BIGINT";
            case "SMALLINT":
            case "INT2":
                return "SMALLINT";
            case "BOOL":
                return "BOOLEAN";
            case "FLOAT4":
                return "REAL";
            case "FLOAT8":
                return "DOUBLE PRECISION";
            case "BPCHAR":
                return "CHAR" + (len != null && len > 0 ? "(" + len + ")" : "");
            case "JSON":
            case "JSONB":
                return "JSONB";
            case "UUID":
                return "UUID";
            case "TIMESTAMPTZ":
                return "TIMESTAMP WITH TIME ZONE";
            case "FLOAT":
            case "BINARY_DOUBLE":
                return "DOUBLE PRECISION";
            case "BINARY_FLOAT":
                return "REAL";
            case "REAL":
                return "REAL";
            case "DOUBLE":
                return "DOUBLE PRECISION";
            case "CLOB":
            case "NCLOB":
            case "LONG":
            case "TEXT":
                return "TEXT";
            case "BLOB":
            case "RAW":
                return "BYTEA";
            case "DATE":
                // Oracle DATE 는 시각 포함이지만 demo / date-only 의도가 일반적.
                // 시각이 필요하면 TO-BE DDL 에서 TIMESTAMP 명시 권장.
                return "DATE";
            case "TIMESTAMP":
                if (p != null && p >= 0 && p <= 6) return "TIMESTAMP(" + p + ")";
                return "TIMESTAMP";
            case "BOOLEAN":
                return "BOOLEAN";
            default:
                // 알 수 없는 타입 — raw 그대로 (이미 PG-compatible 인 케이스 가정).
                String raw = c.getDataTypeRaw();
                return raw != null && !raw.isBlank() ? raw : dt;
        }
    }

    private static String ident(String name) {
        return "\"" + name.replace("\"", "\"\"") + "\"";
    }

    /** schema.table 형태의 quoted identifier. schema 가 비면 unquoted. */
    public static String qualifiedTable(String schema, String table) {
        if (schema == null || schema.isBlank()) return ident(table);
        return ident(schema) + "." + ident(table);
    }

    /**
     * UK 부착 SQL. {@code ALTER TABLE ... ADD CONSTRAINT name UNIQUE (cols)}.
     * 이미 존재 시 PG 가 에러 → 호출 측이 try/catch 로 멱등 보장.
     */
    public static String addUniqueConstraintSql(String schema, String table,
                                                String constraintName, List<String> columns) {
        String quotedCols = columns.stream().map(PgDdlGenerator::ident).collect(Collectors.joining(", "));
        return "ALTER TABLE " + qualifiedTable(schema, table)
                + " ADD CONSTRAINT " + ident(constraintName)
                + " UNIQUE (" + quotedCols + ")";
    }

    /**
     * FK 부착 SQL (NOT VALID). {@code ALTER TABLE ... ADD CONSTRAINT fk FOREIGN KEY (...) REFERENCES ref(...) [ON DELETE ...] [ON UPDATE ...] [DEFERRABLE ...] NOT VALID}.
     * NOT VALID 로 부착하면 기존 데이터의 검증은 건너뛰고 신규 INSERT 부터 강제. 검증은 {@link #validateForeignKeySql} 로 분리.
     *
     * @param deferrableInfo 예) "DEFERRABLE INITIALLY DEFERRED" / "DEFERRABLE INITIALLY IMMEDIATE" / "DEFERRABLE" / null
     */
    public static String addForeignKeyNotValidSql(String schema, String table, String fkName,
                                                  List<String> columns,
                                                  String refSchema, String refTable, List<String> refColumns,
                                                  String onDelete, String onUpdate, String deferrableInfo) {
        String quotedCols = columns.stream().map(PgDdlGenerator::ident).collect(Collectors.joining(", "));
        String quotedRefCols = refColumns.stream().map(PgDdlGenerator::ident).collect(Collectors.joining(", "));
        StringBuilder sb = new StringBuilder();
        sb.append("ALTER TABLE ").append(qualifiedTable(schema, table))
                .append(" ADD CONSTRAINT ").append(ident(fkName))
                .append(" FOREIGN KEY (").append(quotedCols).append(")")
                .append(" REFERENCES ").append(qualifiedTable(refSchema, refTable))
                .append(" (").append(quotedRefCols).append(")");
        if (onDelete != null && !onDelete.isBlank() && !"NO ACTION".equalsIgnoreCase(onDelete.trim())) {
            sb.append(" ON DELETE ").append(onDelete.trim().toUpperCase());
        }
        if (onUpdate != null && !onUpdate.isBlank() && !"NO ACTION".equalsIgnoreCase(onUpdate.trim())) {
            sb.append(" ON UPDATE ").append(onUpdate.trim().toUpperCase());
        }
        if (deferrableInfo != null && !deferrableInfo.isBlank()) {
            sb.append(" ").append(deferrableInfo.trim().toUpperCase());
        }
        sb.append(" NOT VALID");
        return sb.toString();
    }

    /** {@code ALTER TABLE ... VALIDATE CONSTRAINT fk}. NOT VALID 로 부착한 FK 의 기존 데이터 검증. */
    public static String validateForeignKeySql(String schema, String table, String fkName) {
        return "ALTER TABLE " + qualifiedTable(schema, table)
                + " VALIDATE CONSTRAINT " + ident(fkName);
    }

    /**
     * CHECK 부착 SQL (NOT VALID). {@code ALTER TABLE ... ADD CONSTRAINT name CHECK (expr) NOT VALID}.
     * NOT VALID 라 기존 데이터 검증 skip → {@link #validateCheckConstraintSql} 로 분리 검증.
     */
    public static String addCheckConstraintNotValidSql(String schema, String table,
                                                       String constraintName, String checkExpression) {
        return "ALTER TABLE " + qualifiedTable(schema, table)
                + " ADD CONSTRAINT " + ident(constraintName)
                + " CHECK (" + checkExpression + ") NOT VALID";
    }

    /** {@code ALTER TABLE ... VALIDATE CONSTRAINT name}. CHECK 도 FK 와 동일한 검증 명령. */
    public static String validateCheckConstraintSql(String schema, String table, String constraintName) {
        return "ALTER TABLE " + qualifiedTable(schema, table)
                + " VALIDATE CONSTRAINT " + ident(constraintName);
    }

    /** 디버그용 — 컬럼 리스트를 한 줄로 (테스트 가독성). */
    @SuppressWarnings("unused")
    static String oneLineColumnList(List<DdlColumn> cols) {
        return cols.stream().map(c -> c.getPhysicalName() + " " + toPgType(c))
                .collect(Collectors.joining(", "));
    }
}

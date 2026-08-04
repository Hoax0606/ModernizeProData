package com.ksinfo.modernize_pro_data.coordinator.load.oracle;

import com.ksinfo.modernize_pro_data.coordinator.ddl.DdlColumn;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** OracleDdlGenerator — 타입 매핑(CHAR 의미), 멱등 PL/SQL, quote-everywhere, Oracle FK 특유 처리. */
class OracleDdlGeneratorTest {

    private static DdlColumn col(String name, String type) {
        return DdlColumn.create("t", 0, name, type, type);
    }

    private static DdlColumn col(String name, String type, Integer len, Integer p, Integer s) {
        DdlColumn c = col(name, type);
        c.setLength(len);
        c.setPrecision(p);
        c.setScale(s);
        return c;
    }

    @Test
    void typeMapping_charSemanticsAndOracleTypes() {
        assertEquals("VARCHAR2(100 CHAR)", OracleDdlGenerator.toOracleType(col("c", "VARCHAR2", 100, null, null)));
        assertEquals("VARCHAR2(4000 CHAR)", OracleDdlGenerator.toOracleType(col("c", "VARCHAR2", null, null, null)));
        assertEquals("CLOB", OracleDdlGenerator.toOracleType(col("c", "VARCHAR2", 8000, null, null)));
        assertEquals("CHAR(2 CHAR)", OracleDdlGenerator.toOracleType(col("c", "CHAR", 2, null, null)));
        assertEquals("NUMBER(10,2)", OracleDdlGenerator.toOracleType(col("c", "NUMBER", null, 10, 2)));
        assertEquals("NUMBER(10)", OracleDdlGenerator.toOracleType(col("c", "NUMBER", null, 10, 0)));
        assertEquals("NUMBER", OracleDdlGenerator.toOracleType(col("c", "NUMBER")));
        assertEquals("NUMBER(10)", OracleDdlGenerator.toOracleType(col("c", "INTEGER")));
        assertEquals("NUMBER(19)", OracleDdlGenerator.toOracleType(col("c", "BIGINT")));
        assertEquals("NUMBER(1)", OracleDdlGenerator.toOracleType(col("c", "BOOLEAN")));  // pre-23c no boolean
        assertEquals("DATE", OracleDdlGenerator.toOracleType(col("c", "DATE")));
        assertEquals("TIMESTAMP", OracleDdlGenerator.toOracleType(col("c", "TIMESTAMP")));
        assertEquals("TIMESTAMP WITH TIME ZONE", OracleDdlGenerator.toOracleType(col("c", "TIMESTAMPTZ")));
        assertEquals("CLOB", OracleDdlGenerator.toOracleType(col("c", "TEXT")));
        assertEquals("BLOB", OracleDdlGenerator.toOracleType(col("c", "BLOB")));
        assertEquals("BINARY_DOUBLE", OracleDdlGenerator.toOracleType(col("c", "DOUBLE PRECISION")));
    }

    @Test
    void createTable_idempotentPlsqlWrapper() {
        DdlColumn id = col("ID", "INTEGER");
        id.setNullable(false);
        id.setPkOrder(1);
        DdlColumn name = col("NAME", "VARCHAR2", 100, null, null);

        String sql = OracleDdlGenerator.createTableIfNotExists("APP", "CUST", List.of(id, name), "JA16SJIS");
        assertEquals("BEGIN EXECUTE IMMEDIATE 'CREATE TABLE \"APP\".\"CUST\" "
                + "(\"ID\" NUMBER(10) NOT NULL, \"NAME\" VARCHAR2(100 CHAR))'; "
                + "EXCEPTION WHEN OTHERS THEN IF SQLCODE != -955 THEN RAISE; END IF; END;", sql);
    }

    @Test
    void createSchema_isNoOp() {
        assertEquals("BEGIN NULL; END;", OracleDdlGenerator.createSchemaIfNotExists("APP"));
    }

    @Test
    void primaryKeyAndUnique() {
        assertEquals("ALTER TABLE \"APP\".\"CUST\" ADD PRIMARY KEY (\"ID\")",
                OracleDdlGenerator.addPrimaryKeySql("APP", "CUST", List.of("ID")));
        assertEquals("ALTER TABLE \"APP\".\"CUST\" ADD CONSTRAINT \"UK_EMAIL\" UNIQUE (\"EMAIL\")",
                OracleDdlGenerator.addUniqueConstraintSql("APP", "CUST", "UK_EMAIL", List.of("EMAIL")));
    }

    @Test
    void foreignKey_ignoresOnUpdate_onDeleteCascadeOnly_enableNovalidate() {
        String fk = OracleDdlGenerator.addForeignKeyNotValidSql("APP", "ORD", "FK_CUST",
                List.of("CUST_ID"), "APP", "CUST", List.of("ID"),
                "CASCADE", "CASCADE", null);   // onUpdate=CASCADE must be dropped (Oracle 미지원)
        assertEquals("ALTER TABLE \"APP\".\"ORD\" ADD CONSTRAINT \"FK_CUST\" "
                + "FOREIGN KEY (\"CUST_ID\") REFERENCES \"APP\".\"CUST\" (\"ID\") "
                + "ON DELETE CASCADE ENABLE NOVALIDATE", fk);
        assertTrue(!fk.contains("ON UPDATE"), "Oracle 은 ON UPDATE 미지원 — 절대 포함 금지");

        // RESTRICT/NO ACTION 은 절 생략 (Oracle 기본).
        String fk2 = OracleDdlGenerator.addForeignKeyNotValidSql("APP", "ORD", "FK2",
                List.of("CUST_ID"), "APP", "CUST", List.of("ID"), "NO ACTION", null, null);
        assertTrue(!fk2.contains("ON DELETE"), "NO ACTION 은 ON DELETE 절 생략: " + fk2);
        assertTrue(fk2.endsWith("ENABLE NOVALIDATE"));
    }

    @Test
    void checkConstraintAndValidate() {
        assertEquals("ALTER TABLE \"APP\".\"CUST\" ADD CONSTRAINT \"CK_AGE\" "
                + "CHECK (age >= 0) ENABLE NOVALIDATE",
                OracleDdlGenerator.addCheckConstraintNotValidSql("APP", "CUST", "CK_AGE", "age >= 0"));
        assertEquals("ALTER TABLE \"APP\".\"CUST\" ENABLE VALIDATE CONSTRAINT \"FK_CUST\"",
                OracleDdlGenerator.validateForeignKeySql("APP", "CUST", "FK_CUST"));
        assertEquals("ALTER TABLE \"APP\".\"CUST\" ENABLE VALIDATE CONSTRAINT \"CK_AGE\"",
                OracleDdlGenerator.validateCheckConstraintSql("APP", "CUST", "CK_AGE"));
    }
}

package com.ksinfo.modernize_pro_data.coordinator.ddl.parser;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class OracleDdlParserTest {

    private final OracleDdlParser parser = new OracleDdlParser();

    @Test
    void parsesSimpleCreateTableWithSchema() {
        String sql = """
                CREATE TABLE HR.EMPLOYEES (
                    EMP_ID    NUMBER(10) NOT NULL,
                    EMP_NAME  VARCHAR2(50 BYTE) NOT NULL,
                    HIRE_DATE DATE DEFAULT SYSDATE NOT NULL,
                    SALARY    NUMBER(12,2),
                    DEPT_ID   NUMBER(5)
                );
                """;
        ParsedDdl result = parser.parse(sql);

        assertThat(result.getTables()).hasSize(1);
        ParsedTable t = result.getTables().get(0);
        assertThat(t.getSchemaName()).isEqualTo("HR");
        assertThat(t.getPhysicalName()).isEqualTo("EMPLOYEES");
        assertThat(t.getColumns()).hasSize(5);

        ParsedColumn empId = t.getColumns().get(0);
        assertThat(empId.getPhysicalName()).isEqualTo("EMP_ID");
        assertThat(empId.getDataType()).isEqualTo("NUMBER");
        assertThat(empId.getDataTypeRaw()).isEqualTo("NUMBER(10)");
        assertThat(empId.getPrecision()).isEqualTo(10);
        assertThat(empId.isNullable()).isFalse();

        ParsedColumn empName = t.getColumns().get(1);
        assertThat(empName.getDataType()).isEqualTo("VARCHAR2");
        assertThat(empName.getLength()).isEqualTo(50);
        assertThat(empName.isNullable()).isFalse();

        ParsedColumn hireDate = t.getColumns().get(2);
        assertThat(hireDate.getDataType()).isEqualTo("DATE");
        assertThat(hireDate.getDefaultValue()).isEqualTo("SYSDATE");
        assertThat(hireDate.isNullable()).isFalse();

        ParsedColumn salary = t.getColumns().get(3);
        assertThat(salary.getDataType()).isEqualTo("NUMBER");
        assertThat(salary.getPrecision()).isEqualTo(12);
        assertThat(salary.getScale()).isEqualTo(2);
        assertThat(salary.isNullable()).isTrue();
    }

    @Test
    void parsesCreateTableWithoutSchema() {
        String sql = "CREATE TABLE DEPT (DEPT_ID NUMBER(5), DEPT_NAME VARCHAR2(50));";
        ParsedDdl result = parser.parse(sql);

        assertThat(result.getTables()).hasSize(1);
        assertThat(result.getTables().get(0).getSchemaName()).isEmpty();
        assertThat(result.getTables().get(0).getPhysicalName()).isEqualTo("DEPT");
    }

    @Test
    void parsesInlinePrimaryKey() {
        String sql = "CREATE TABLE DEPT (DEPT_ID NUMBER(5) PRIMARY KEY, DEPT_NAME VARCHAR2(50));";
        ParsedDdl result = parser.parse(sql);

        ParsedColumn pk = result.getTables().get(0).getColumns().get(0);
        assertThat(pk.getPkOrder()).isEqualTo(1);
        assertThat(pk.isNullable()).isFalse();
    }

    @Test
    void parsesTableLevelCompositePrimaryKey() {
        String sql = """
                CREATE TABLE T (
                    A NUMBER, B NUMBER, C NUMBER,
                    CONSTRAINT PK_T PRIMARY KEY (A, B)
                );
                """;
        ParsedDdl result = parser.parse(sql);
        var cols = result.getTables().get(0).getColumns();

        assertThat(cols).hasSize(3);
        assertThat(cols.get(0).getPhysicalName()).isEqualTo("A");
        assertThat(cols.get(0).getPkOrder()).isEqualTo(1);
        assertThat(cols.get(0).isNullable()).isFalse();
        assertThat(cols.get(1).getPkOrder()).isEqualTo(2);
        assertThat(cols.get(2).getPkOrder()).isNull();
    }

    @Test
    void ignoresFkAndIndexConstraints() {
        String sql = """
                CREATE TABLE T (
                    A NUMBER,
                    B NUMBER,
                    CONSTRAINT FK_T_OTHER FOREIGN KEY (B) REFERENCES OTHER(ID),
                    CONSTRAINT UQ_T_A UNIQUE (A)
                );
                """;
        ParsedDdl result = parser.parse(sql);
        assertThat(result.getTables().get(0).getColumns()).hasSize(2);
    }

    @Test
    void usesCommentOnColumnAsLogicalName() {
        String sql = """
                CREATE TABLE HR.EMP (
                    EMP_ID NUMBER(10) NOT NULL
                );
                COMMENT ON TABLE HR.EMP IS '従業員マスタ';
                COMMENT ON COLUMN HR.EMP.EMP_ID IS '社員番号';
                """;
        ParsedDdl result = parser.parse(sql);

        ParsedTable t = result.getTables().get(0);
        assertThat(t.getLogicalName()).isEqualTo("従業員マスタ");
        assertThat(t.getTableComment()).isEqualTo("従業員マスタ");
        assertThat(t.getColumns().get(0).getLogicalName()).isEqualTo("社員番号");
        assertThat(t.getColumns().get(0).getColumnComment()).isEqualTo("社員番号");
    }

    @Test
    void fallsBackToInlineCommentAsLogicalName() {
        String sql = """
                CREATE TABLE T (
                    EMP_ID NUMBER(10) NOT NULL, -- 社員番号
                    EMP_NAME VARCHAR2(50) /* 社員氏名 */
                );
                """;
        ParsedDdl result = parser.parse(sql);
        var cols = result.getTables().get(0).getColumns();
        assertThat(cols.get(0).getLogicalName()).isEqualTo("社員番号");
        assertThat(cols.get(0).getInlineComment()).isEqualTo("社員番号");
        assertThat(cols.get(1).getLogicalName()).isEqualTo("社員氏名");
    }

    @Test
    void commentOnColumnOverridesInlineComment() {
        String sql = """
                CREATE TABLE HR.EMP (
                    EMP_ID NUMBER(10) NOT NULL -- 古いコメント
                );
                COMMENT ON COLUMN HR.EMP.EMP_ID IS '社員番号';
                """;
        ParsedDdl result = parser.parse(sql);
        ParsedColumn col = result.getTables().get(0).getColumns().get(0);
        assertThat(col.getLogicalName()).isEqualTo("社員番号");
        assertThat(col.getInlineComment()).isEqualTo("古いコメント");
        assertThat(col.getColumnComment()).isEqualTo("社員番号");
    }

    @Test
    void parsesMultipleTablesWithLeadingComments() {
        // 실제 사용자 보고 케이스: 파일 선두 및 각 CREATE TABLE 앞에 코멘트가 있으면
        // 이전 버전은 코멘트로 시작하는 statement 를 CREATE 로 인식하지 못해 1 개만 처리되었음.
        String sql = """
                -- セット1: 勘定系コア業務 DDL (Oracle)
                CREATE TABLE ACCOUNT_MASTER (
                    ACCOUNT_NO        NUMBER(15,0) NOT NULL,
                    CUSTOMER_NAME     VARCHAR2(100) NOT NULL,
                    BALANCE           NUMBER(15,3) DEFAULT 0 NOT NULL,
                    OPEN_DATE         DATE DEFAULT SYSDATE NOT NULL,
                    CONSTRAINT PK_ACCOUNT_MASTER PRIMARY KEY (ACCOUNT_NO)
                );

                CREATE TABLE TRANSACTION_HISTORY (
                    TX_ID             NUMBER(15,0) NOT NULL,
                    ACCOUNT_NO        NUMBER(15,0) NOT NULL,
                    TX_TYPE           CHAR(2) NOT NULL,
                    AMOUNT            NUMBER(15,3) NOT NULL,
                    TX_DATETIME       DATE DEFAULT SYSDATE NOT NULL,
                    CONSTRAINT PK_TRANSACTION_HISTORY PRIMARY KEY (TX_ID)
                );
                """;
        ParsedDdl result = parser.parse(sql);
        assertThat(result.getTables()).hasSize(2);
        assertThat(result.getTables().get(0).getPhysicalName()).isEqualTo("ACCOUNT_MASTER");
        assertThat(result.getTables().get(0).getColumns()).hasSize(4);
        assertThat(result.getTables().get(1).getPhysicalName()).isEqualTo("TRANSACTION_HISTORY");
        assertThat(result.getTables().get(1).getColumns()).hasSize(5);
        assertThat(result.totalColumnCount()).isEqualTo(9);
    }

    @Test
    void parsesMultipleTables() {
        String sql = """
                CREATE TABLE T1 (A NUMBER);
                CREATE TABLE T2 (B VARCHAR2(10));
                """;
        ParsedDdl result = parser.parse(sql);
        assertThat(result.getTables()).hasSize(2);
        assertThat(result.getTables().get(0).getOrdinal()).isEqualTo(0);
        assertThat(result.getTables().get(1).getOrdinal()).isEqualTo(1);
    }

    @Test
    void returnsEmptyForBlankInput() {
        assertThat(parser.parse(null).getTables()).isEmpty();
        assertThat(parser.parse("").getTables()).isEmpty();
        assertThat(parser.parse("   \n  ").getTables()).isEmpty();
    }

    @Test
    void handlesEscapedSingleQuoteInComment() {
        String sql = """
                CREATE TABLE T (A NUMBER);
                COMMENT ON TABLE T IS 'It''s a test';
                """;
        ParsedDdl result = parser.parse(sql);
        assertThat(result.getTables().get(0).getLogicalName()).isEqualTo("It's a test");
    }

    @Test
    void totalColumnCount() {
        String sql = """
                CREATE TABLE T1 (A NUMBER, B NUMBER);
                CREATE TABLE T2 (C NUMBER, D NUMBER, E NUMBER);
                """;
        ParsedDdl result = parser.parse(sql);
        assertThat(result.totalColumnCount()).isEqualTo(5);
    }
}

package com.ksinfo.modernize_pro_data.coordinator.ddl.parser;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.postgresql.ds.PGSimpleDataSource;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

import javax.sql.DataSource;
import java.sql.Connection;
import java.sql.ResultSet;
import java.sql.Statement;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * PgSchemaExtractor 통합 테스트. Testcontainers 로 일회용 PG 18 컨테이너 사용.
 *
 * 검증 범위:
 *   - 기본 테이블/컬럼/PK 추출
 *   - UK / FK / CHECK 추출
 *   - 보조 인덱스 추출
 *   - Oracle 문법 거부 (TO-BE 는 PG 라는 정책)
 *   - staging schema cleanup
 *   - PG 가 PRIMARY KEY 제약으로 자동 생성하는 {@code <table>_pkey} 인덱스 확인 (Task #8 회귀)
 */
@Testcontainers
class PgSchemaExtractorIT {

    @Container
    static PostgreSQLContainer<?> pg = new PostgreSQLContainer<>("postgres:18-alpine");

    private DataSource dataSource;
    private PgSchemaExtractor extractor;

    @BeforeEach
    void setUp() {
        PGSimpleDataSource ds = new PGSimpleDataSource();
        ds.setUrl(pg.getJdbcUrl());
        ds.setUser(pg.getUsername());
        ds.setPassword(pg.getPassword());
        this.dataSource = ds;
        this.extractor = new PgSchemaExtractor(ds);
    }

    @Test
    void extractsBasicTableWithColumns() {
        String ddl = """
                CREATE TABLE emp (
                    id INTEGER PRIMARY KEY,
                    name VARCHAR(100) NOT NULL,
                    hired DATE
                );
                """;
        ParsedDdl result = extractor.extract(ddl.getBytes());

        assertThat(result.getTables()).hasSize(1);
        ParsedTable t = result.getTables().get(0);
        assertThat(t.getPhysicalName()).isEqualTo("emp");
        assertThat(t.getColumns()).hasSize(3);

        ParsedColumn id = t.getColumns().get(0);
        assertThat(id.getPhysicalName()).isEqualTo("id");
        assertThat(id.getPkOrder()).isEqualTo(1);
        assertThat(id.isNullable()).isFalse();

        ParsedColumn name = t.getColumns().get(1);
        assertThat(name.getLength()).isEqualTo(100);
        assertThat(name.isNullable()).isFalse();

        ParsedColumn hired = t.getColumns().get(2);
        assertThat(hired.isNullable()).isTrue();
    }

    @Test
    void extractsCompositePrimaryKey() {
        String ddl = """
                CREATE TABLE order_item (
                    order_id INTEGER NOT NULL,
                    line_no INTEGER NOT NULL,
                    qty INTEGER,
                    PRIMARY KEY (order_id, line_no)
                );
                """;
        ParsedDdl result = extractor.extract(ddl.getBytes());

        ParsedTable t = result.getTables().get(0);
        assertThat(t.getColumns().stream().filter(c -> c.getPkOrder() != null).count()).isEqualTo(2);
        assertThat(t.getColumns().get(0).getPkOrder()).isEqualTo(1);
        assertThat(t.getColumns().get(1).getPkOrder()).isEqualTo(2);
        assertThat(t.getColumns().get(2).getPkOrder()).isNull();
    }

    @Test
    void extractsUniqueConstraint() {
        String ddl = """
                CREATE TABLE u (
                    id INTEGER PRIMARY KEY,
                    email VARCHAR(200),
                    CONSTRAINT uq_u_email UNIQUE (email)
                );
                """;
        ParsedDdl result = extractor.extract(ddl.getBytes());

        assertThat(result.getConstraints()).anyMatch(c ->
                ParsedConstraint.TYPE_UK.equals(c.getType())
                        && "uq_u_email".equals(c.getName())
                        && c.getColumns().size() == 1
                        && "email".equals(c.getColumns().get(0).getColumnName()));
    }

    @Test
    void extractsForeignKeyWithRefColumnsAndOnDelete() {
        String ddl = """
                CREATE TABLE parent (id INTEGER PRIMARY KEY);
                CREATE TABLE child (
                    id INTEGER PRIMARY KEY,
                    parent_id INTEGER,
                    CONSTRAINT fk_child_parent FOREIGN KEY (parent_id) REFERENCES parent(id) ON DELETE CASCADE
                );
                """;
        ParsedDdl result = extractor.extract(ddl.getBytes());

        ParsedConstraint fk = result.getConstraints().stream()
                .filter(c -> ParsedConstraint.TYPE_FK.equals(c.getType()))
                .findFirst().orElseThrow();
        assertThat(fk.getName()).isEqualTo("fk_child_parent");
        assertThat(fk.getTableName()).isEqualTo("child");
        assertThat(fk.getColumns()).hasSize(1);
        assertThat(fk.getColumns().get(0).getColumnName()).isEqualTo("parent_id");
        assertThat(fk.getColumns().get(0).getRefColumnName()).isEqualTo("id");
        assertThat(fk.getForeignKey().getRefTableName()).isEqualTo("parent");
        assertThat(fk.getForeignKey().getOnDelete()).isEqualTo("CASCADE");
    }

    @Test
    void extractsCompositeForeignKey() {
        String ddl = """
                CREATE TABLE parent (a INTEGER, b INTEGER, PRIMARY KEY (a, b));
                CREATE TABLE child (
                    c1 INTEGER, c2 INTEGER,
                    CONSTRAINT fk_c FOREIGN KEY (c1, c2) REFERENCES parent(a, b)
                );
                """;
        ParsedDdl result = extractor.extract(ddl.getBytes());

        ParsedConstraint fk = result.getConstraints().stream()
                .filter(c -> ParsedConstraint.TYPE_FK.equals(c.getType()))
                .findFirst().orElseThrow();
        assertThat(fk.getColumns()).hasSize(2);
        assertThat(fk.getColumns().get(0).getColumnName()).isEqualTo("c1");
        assertThat(fk.getColumns().get(0).getRefColumnName()).isEqualTo("a");
        assertThat(fk.getColumns().get(1).getColumnName()).isEqualTo("c2");
        assertThat(fk.getColumns().get(1).getRefColumnName()).isEqualTo("b");
    }

    @Test
    void extractsCheckConstraint() {
        String ddl = """
                CREATE TABLE emp (
                    id INTEGER PRIMARY KEY,
                    salary NUMERIC,
                    CONSTRAINT ck_emp_sal CHECK (salary > 0)
                );
                """;
        ParsedDdl result = extractor.extract(ddl.getBytes());

        ParsedConstraint ck = result.getConstraints().stream()
                .filter(c -> ParsedConstraint.TYPE_CHECK.equals(c.getType()))
                .findFirst().orElseThrow();
        assertThat(ck.getName()).isEqualTo("ck_emp_sal");
        assertThat(ck.getCheckExpression()).contains("salary > (0)::numeric");
    }

    @Test
    void extractsSecondaryIndex() {
        String ddl = """
                CREATE TABLE t (id INTEGER PRIMARY KEY, name VARCHAR(50));
                CREATE INDEX idx_t_name ON t (name);
                """;
        ParsedDdl result = extractor.extract(ddl.getBytes());

        ParsedIndex idx = result.getIndexes().stream()
                .filter(i -> "idx_t_name".equals(i.getName()))
                .findFirst().orElseThrow();
        assertThat(idx.getTableName()).isEqualTo("t");
        assertThat(idx.isUnique()).isFalse();
        assertThat(idx.getType()).isEqualTo("btree");
        assertThat(idx.getColumns()).hasSize(1);
        assertThat(idx.getColumns().get(0).getColumnName()).isEqualTo("name");
    }

    @Test
    void skipsPkIndexAndUkUnderlyingIndex() {
        // PG 의 PRIMARY KEY 와 UNIQUE constraint 가 자동 생성하는 underlying index 는
        // ParsedIndex 로 안 잡혀야 한다 (constraint 로만 잡힘).
        String ddl = """
                CREATE TABLE t (
                    id INTEGER PRIMARY KEY,
                    email VARCHAR(100),
                    CONSTRAINT uq_t_email UNIQUE (email)
                );
                """;
        ParsedDdl result = extractor.extract(ddl.getBytes());

        assertThat(result.getIndexes()).isEmpty();
        assertThat(result.getConstraints()).anyMatch(c -> ParsedConstraint.TYPE_UK.equals(c.getType()));
    }

    @Test
    void rejectsOracleSyntax() {
        // Oracle 의 NUMBER 는 PG 엔 없음 → PG 가 적용 거부 → TobeDdlApplyException
        String oracleDdl = "CREATE TABLE t (id NUMBER(10) PRIMARY KEY, name VARCHAR2(50));";
        assertThatThrownBy(() -> extractor.extract(oracleDdl.getBytes()))
                .isInstanceOf(PgSchemaExtractor.TobeDdlApplyException.class)
                .hasMessageContaining("TO-BE DDL 적용 실패");
    }

    @Test
    void cleansUpStagingSchemaAfterExtraction() throws Exception {
        String ddl = "CREATE TABLE leftover (id INTEGER);";
        extractor.extract(ddl.getBytes());

        // extract 후 어떤 staging schema 도 남아있지 않아야 한다.
        try (Connection conn = dataSource.getConnection();
             Statement st = conn.createStatement();
             ResultSet rs = st.executeQuery(
                     "SELECT schema_name FROM information_schema.schemata "
                             + "WHERE schema_name LIKE 'tobe_ddl_validate_%'")) {
            assertThat(rs.next()).as("staging schema 가 cleanup 되지 않음").isFalse();
        }
    }

    @Test
    void cleansUpStagingSchemaEvenOnApplyFailure() throws Exception {
        String oracleDdl = "CREATE TABLE bad (id NUMBER(10));";
        try {
            extractor.extract(oracleDdl.getBytes());
        } catch (PgSchemaExtractor.TobeDdlApplyException ignored) {
            // 예상된 실패
        }

        try (Connection conn = dataSource.getConnection();
             Statement st = conn.createStatement();
             ResultSet rs = st.executeQuery(
                     "SELECT schema_name FROM information_schema.schemata "
                             + "WHERE schema_name LIKE 'tobe_ddl_validate_%'")) {
            assertThat(rs.next()).as("실패 후에도 staging schema 가 cleanup 되어야 함").isFalse();
        }
    }

    /**
     * Task #8 회귀 — PG 가 PRIMARY KEY 제약 부착 시 자동으로 {@code <table>_pkey} 라는
     * unique index 를 만든다. 이걸 확인. (LoadStage.ensurePkIndex 제거의 정당화 근거)
     */
    @Test
    void pgAutoCreatesPkeyIndexWithPrimaryKeyConstraint() throws Exception {
        // staging schema 에 직접 적용 후 인덱스 확인.
        String testSchema = "pkey_test_" + System.nanoTime();
        try (Connection conn = dataSource.getConnection();
             Statement st = conn.createStatement()) {
            st.execute("CREATE SCHEMA " + testSchema);
            st.execute("CREATE TABLE " + testSchema + ".t (id INTEGER PRIMARY KEY, name VARCHAR(50))");

            try (ResultSet rs = st.executeQuery(
                    "SELECT indexname FROM pg_indexes WHERE schemaname = '" + testSchema + "'")) {
                List<String> indexes = new java.util.ArrayList<>();
                while (rs.next()) indexes.add(rs.getString(1));
                assertThat(indexes).contains("t_pkey");
            }
            st.execute("DROP SCHEMA " + testSchema + " CASCADE");
        }
    }
}

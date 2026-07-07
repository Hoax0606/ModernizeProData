package com.ksinfo.modernize_pro_data.coordinator.worker.stages;

import com.ksinfo.modernize_pro_data.coordinator.run.RunHistory;
import com.ksinfo.modernize_pro_data.coordinator.site.Project;
import com.ksinfo.modernize_pro_data.coordinator.worker.StageContext;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * LoadStage 의 ensure* 메서드 통합 테스트 (Testcontainers).
 *
 * 검증:
 *   - ensureUniqueConstraints 가 실제 PG 에 UK 부착 + UK 중복 INSERT 거부
 *   - ensureForeignKeys 가 NOT VALID + VALIDATE 2단계 부착 + FK 위반 INSERT 거부
 *   - ON DELETE CASCADE 실제 동작
 *   - Composite FK 부착
 *   - 이미 존재하는 constraint 재부착 시 멱등 (skip + log)
 *
 * 주의: ingest 호출이 RunLogIngestService 까지 도달하지만 RunHistory 가 DB 에 없어서
 * FK 위반으로 fail — 그 catch 는 ensure* 의 외부 catch (Exception) 가 잡고 log.warn 만.
 * PG 부착 자체는 autoCommit=true 상태에서 이미 commit 됨 → 검증에 영향 없음.
 */
@SpringBootTest
@Testcontainers
class LoadStageConstraintAttachIT {

    @Container
    static PostgreSQLContainer<?> pg = new PostgreSQLContainer<>("postgres:18-alpine");

    @DynamicPropertySource
    static void overrideDataSource(DynamicPropertyRegistry registry) {
        registry.add("spring.datasource.url", pg::getJdbcUrl);
        registry.add("spring.datasource.username", pg::getUsername);
        registry.add("spring.datasource.password", pg::getPassword);
        registry.add("spring.datasource.driver-class-name", () -> "org.postgresql.Driver");
        registry.add("spring.flyway.enabled", () -> "true");
        registry.add("spring.jpa.hibernate.ddl-auto", () -> "validate");
    }

    @Autowired LoadStage loadStage;

    private Connection conn;
    private String schema;

    @BeforeEach
    void openConnAndCreateSchema() throws SQLException {
        conn = DriverManager.getConnection(pg.getJdbcUrl(), pg.getUsername(), pg.getPassword());
        conn.setAutoCommit(true);
        schema = "lst_" + System.nanoTime();
        try (Statement st = conn.createStatement()) {
            st.execute("CREATE SCHEMA " + schema);
        }
    }

    @AfterEach
    void cleanup() throws SQLException {
        try (Statement st = conn.createStatement()) {
            st.execute("DROP SCHEMA IF EXISTS " + schema + " CASCADE");
        } finally {
            conn.close();
        }
    }

    private StageContext minimalCtx() {
        RunHistory rh = new RunHistory();
        rh.setId("r-test0001");
        rh.setProjectId("p-test0001");
        Project p = new Project();
        p.setId("p-test0001");
        return StageContext.builder()
                .runHistory(rh)
                .project(p)
                .build();
    }

    @Test
    void attachesUniqueConstraintAndPgRejectsDuplicate() throws SQLException {
        try (Statement st = conn.createStatement()) {
            st.execute("CREATE TABLE " + schema + ".emp (id INTEGER PRIMARY KEY, email VARCHAR(100))");
        }

        Map<String, List<LoadStage.UniqueConstraintMeta>> uniqueByTable = new HashMap<>();
        uniqueByTable.put("emp", List.of(
                new LoadStage.UniqueConstraintMeta("uq_emp_email", List.of("email"))));

        loadStage.ensureUniqueConstraints(minimalCtx(), conn, schema, "emp", uniqueByTable);

        // PG 에 UK 부착 확인
        try (Statement st = conn.createStatement();
             ResultSet rs = st.executeQuery(
                     "SELECT constraint_name FROM information_schema.table_constraints "
                             + "WHERE table_schema = '" + schema + "' AND table_name = 'emp' "
                             + "AND constraint_type = 'UNIQUE'")) {
            assertThat(rs.next()).as("UK 부착됨").isTrue();
            assertThat(rs.getString(1)).isEqualTo("uq_emp_email");
        }

        // 중복 INSERT 거부
        try (Statement st = conn.createStatement()) {
            st.execute("INSERT INTO " + schema + ".emp VALUES (1, 'a@b.com')");
        }
        assertThatThrownBy(() -> {
            try (Statement st = conn.createStatement()) {
                st.execute("INSERT INTO " + schema + ".emp VALUES (2, 'a@b.com')");
            }
        }).isInstanceOf(SQLException.class)
          .hasMessageContaining("duplicate");
    }

    @Test
    void attachesForeignKeyAndPgRejectsOrphan() throws SQLException {
        try (Statement st = conn.createStatement()) {
            st.execute("CREATE TABLE " + schema + ".parent (id INTEGER PRIMARY KEY)");
            st.execute("CREATE TABLE " + schema + ".child (id INTEGER PRIMARY KEY, parent_id INTEGER)");
        }

        Map<String, List<LoadStage.ForeignKeyMeta>> fksByTable = new HashMap<>();
        fksByTable.put("child", List.of(new LoadStage.ForeignKeyMeta(
                "fk_child_parent", List.of("parent_id"),
                schema, "parent", List.of("id"),
                "NO ACTION", "NO ACTION", null)));

        loadStage.ensureForeignKeys(minimalCtx(), conn, schema, "child", fksByTable);

        // PG 에 FK 부착 확인
        try (Statement st = conn.createStatement();
             ResultSet rs = st.executeQuery(
                     "SELECT constraint_name FROM information_schema.table_constraints "
                             + "WHERE table_schema = '" + schema + "' AND table_name = 'child' "
                             + "AND constraint_type = 'FOREIGN KEY'")) {
            assertThat(rs.next()).as("FK 부착됨").isTrue();
            assertThat(rs.getString(1)).isEqualTo("fk_child_parent");
        }

        // 부모 없는 자식 INSERT 거부
        assertThatThrownBy(() -> {
            try (Statement st = conn.createStatement()) {
                st.execute("INSERT INTO " + schema + ".child VALUES (1, 999)");
            }
        }).isInstanceOf(SQLException.class)
          .hasMessageContaining("violates foreign key constraint");
    }

    @Test
    void onDeleteCascadeActuallyDeletesChildren() throws SQLException {
        try (Statement st = conn.createStatement()) {
            st.execute("CREATE TABLE " + schema + ".parent (id INTEGER PRIMARY KEY)");
            st.execute("CREATE TABLE " + schema + ".child (id INTEGER PRIMARY KEY, parent_id INTEGER)");
        }

        Map<String, List<LoadStage.ForeignKeyMeta>> fksByTable = new HashMap<>();
        fksByTable.put("child", List.of(new LoadStage.ForeignKeyMeta(
                "fk_c", List.of("parent_id"),
                schema, "parent", List.of("id"),
                "CASCADE", "NO ACTION", null)));

        loadStage.ensureForeignKeys(minimalCtx(), conn, schema, "child", fksByTable);

        // 부모 + 자식 데이터
        try (Statement st = conn.createStatement()) {
            st.execute("INSERT INTO " + schema + ".parent VALUES (1), (2)");
            st.execute("INSERT INTO " + schema + ".child VALUES (10, 1), (11, 1), (20, 2)");
        }

        // 부모 1 삭제 → 자식 10, 11 도 CASCADE 삭제
        try (Statement st = conn.createStatement()) {
            st.execute("DELETE FROM " + schema + ".parent WHERE id = 1");
        }
        try (Statement st = conn.createStatement();
             ResultSet rs = st.executeQuery("SELECT COUNT(*) FROM " + schema + ".child")) {
            rs.next();
            assertThat(rs.getInt(1)).as("CASCADE 로 자식 row 삭제됨").isEqualTo(1);
        }
    }

    @Test
    void attachesCompositeForeignKey() throws SQLException {
        try (Statement st = conn.createStatement()) {
            st.execute("CREATE TABLE " + schema + ".parent (a INTEGER, b INTEGER, PRIMARY KEY (a, b))");
            st.execute("CREATE TABLE " + schema + ".child (c1 INTEGER, c2 INTEGER, PRIMARY KEY (c1, c2))");
        }

        Map<String, List<LoadStage.ForeignKeyMeta>> fksByTable = new HashMap<>();
        fksByTable.put("child", List.of(new LoadStage.ForeignKeyMeta(
                "fk_composite", List.of("c1", "c2"),
                schema, "parent", List.of("a", "b"),
                "NO ACTION", "NO ACTION", null)));

        loadStage.ensureForeignKeys(minimalCtx(), conn, schema, "child", fksByTable);

        try (Statement st = conn.createStatement();
             ResultSet rs = st.executeQuery(
                     "SELECT kcu.column_name, kcu.ordinal_position "
                             + "FROM information_schema.table_constraints tc "
                             + "JOIN information_schema.key_column_usage kcu "
                             + "  ON tc.constraint_name = kcu.constraint_name "
                             + " AND tc.table_schema = kcu.table_schema "
                             + "WHERE tc.table_schema = '" + schema + "' "
                             + "  AND tc.constraint_name = 'fk_composite' "
                             + "ORDER BY kcu.ordinal_position")) {
            assertThat(rs.next()).isTrue();
            assertThat(rs.getString("column_name")).isEqualTo("c1");
            assertThat(rs.next()).isTrue();
            assertThat(rs.getString("column_name")).isEqualTo("c2");
        }
    }

    @Test
    void idempotentReattach() throws SQLException {
        try (Statement st = conn.createStatement()) {
            st.execute("CREATE TABLE " + schema + ".emp (id INTEGER PRIMARY KEY, email VARCHAR(100))");
            // 이미 같은 UK 가 있는 상태
            st.execute("ALTER TABLE " + schema + ".emp ADD CONSTRAINT uq_emp_email UNIQUE (email)");
        }

        Map<String, List<LoadStage.UniqueConstraintMeta>> uniqueByTable = new HashMap<>();
        uniqueByTable.put("emp", List.of(
                new LoadStage.UniqueConstraintMeta("uq_emp_email", List.of("email"))));

        // 재실행 — PG 가 "이미 존재" 에러 → catch + log.warn 만, 메서드는 정상 return
        loadStage.ensureUniqueConstraints(minimalCtx(), conn, schema, "emp", uniqueByTable);

        // UK 가 여전히 정확히 1개 (중복 부착 안 됨)
        try (Statement st = conn.createStatement();
             ResultSet rs = st.executeQuery(
                     "SELECT COUNT(*) FROM information_schema.table_constraints "
                             + "WHERE table_schema = '" + schema + "' AND table_name = 'emp' "
                             + "AND constraint_type = 'UNIQUE'")) {
            rs.next();
            assertThat(rs.getInt(1)).isEqualTo(1);
        }
    }

    /**
     * Task #8 회귀 — CREATE TABLE 시 PRIMARY KEY 가 PG 의 {@code <table>_pkey} unique index 를
     * 자동 생성한다. 별도 ensurePkIndex 불필요.
     */
    @Test
    void pgCreatesTablePkeyIndexAutomatically() throws SQLException {
        try (Statement st = conn.createStatement()) {
            st.execute("CREATE TABLE " + schema + ".t (id INTEGER PRIMARY KEY, name VARCHAR(50))");
        }
        try (Statement st = conn.createStatement();
             ResultSet rs = st.executeQuery(
                     "SELECT indexname FROM pg_indexes "
                             + "WHERE schemaname = '" + schema + "' AND tablename = 't'")) {
            assertThat(rs.next()).as("PG 자동 pkey 인덱스 존재").isTrue();
            assertThat(rs.getString(1)).isEqualTo("t_pkey");
            assertThat(rs.next()).as("다른 인덱스 없음 (idx_pk_* 가 redundant 아님)").isFalse();
        }
    }
}

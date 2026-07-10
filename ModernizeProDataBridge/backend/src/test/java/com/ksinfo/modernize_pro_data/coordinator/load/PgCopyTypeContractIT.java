package com.ksinfo.modernize_pro_data.coordinator.load;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * PgCopyManager 의 Load 타입 계약을 <b>실제 PostgreSQL</b> 로 왕복 검증 (핸드오프 Task C).
 *
 * production 경로 그대로: 인메모리 DuckDB 의 typed ResultSet → {@code copyInFromResultSet}
 * → PG COPY (FORMAT csv). 검증 포인트:
 *   - null → PG NULL / 빈 문자열("") → PG 빈 문자열 (empty↔NULL 구분)
 *   - Boolean/Date/Numeric 가 캐스팅 없이 정확히 적재
 *   - PG boolean 입력이 'Y'/'N'/'1'/'0' 을 받아들임 (도구가 bool 문자열을 그대로 넘겨도 됨)
 *   - 비-text 컬럼에 빈 문자열("")이 가면 COPY 실패 (Transform 이 NULL 로 내보내야 하는 이유)
 *
 * @SpringBootTest 없이 가볍게 — PgCopyManager 는 @Value 기본값(false/null)으로 동작.
 */
@Testcontainers
class PgCopyTypeContractIT {

    @Container
    static PostgreSQLContainer<?> pg = new PostgreSQLContainer<>("postgres:18-alpine");

    private final PgCopyManager copyManager = new PgCopyManager();

    private Connection conn;
    private String schema;

    @BeforeEach
    void setUp() throws SQLException {
        conn = DriverManager.getConnection(pg.getJdbcUrl(), pg.getUsername(), pg.getPassword());
        conn.setAutoCommit(true);
        schema = "ct_" + System.nanoTime();
        try (Statement st = conn.createStatement()) {
            st.execute("CREATE SCHEMA " + schema);
        }
    }

    @AfterEach
    void tearDown() throws SQLException {
        try (Statement st = conn.createStatement()) {
            st.execute("DROP SCHEMA IF EXISTS " + schema + " CASCADE");
        } finally {
            conn.close();
        }
    }

    private static Connection duckdb() throws SQLException {
        try {
            Class.forName("org.duckdb.DuckDBDriver");
        } catch (ClassNotFoundException e) {
            throw new IllegalStateException("duckdb_jdbc not on classpath", e);
        }
        return DriverManager.getConnection("jdbc:duckdb:");
    }

    @Test
    void duckdbResultSet_roundTripsTypes_andDistinguishesEmptyFromNull() throws Exception {
        try (Statement st = conn.createStatement()) {
            st.execute("CREATE TABLE " + schema + ".t ("
                    + "id INTEGER, flag BOOLEAN, d DATE, amt NUMERIC(12,2), note TEXT)");
        }

        try (Connection duck = duckdb(); Statement dst = duck.createStatement()) {
            dst.execute("CREATE TABLE t (id INTEGER, flag BOOLEAN, d DATE, amt DECIMAL(12,2), note VARCHAR)");
            // row1: 모든 값 present
            dst.execute("INSERT INTO t VALUES (1, true, DATE '2024-01-15', 123.45, 'hello')");
            // row2: date/amt = NULL, note = 빈 문자열('')  ← 빈 문자열은 NULL 이 아니어야 함
            dst.execute("INSERT INTO t VALUES (2, false, NULL, NULL, '')");
            // row3: flag/note = NULL, 음수 amt
            dst.execute("INSERT INTO t VALUES (3, NULL, DATE '2023-12-31', -0.01, NULL)");

            try (Statement q = duck.createStatement();
                 ResultSet rs = q.executeQuery("SELECT id, flag, d, amt, note FROM t ORDER BY id")) {
                long rows = copyManager.copyInFromResultSet(
                        conn, schema + ".t", List.of("id", "flag", "d", "amt", "note"), rs);
                assertThat(rows).isEqualTo(3);
            }
        }

        // row1 — 모든 타입 정확히 왕복
        try (Statement st = conn.createStatement();
             ResultSet rs = st.executeQuery(
                     "SELECT flag, d, amt, note FROM " + schema + ".t WHERE id = 1")) {
            assertThat(rs.next()).isTrue();
            assertThat(rs.getBoolean("flag")).isTrue();
            assertThat(rs.getDate("d").toString()).isEqualTo("2024-01-15");
            assertThat(rs.getBigDecimal("amt")).isEqualByComparingTo(new BigDecimal("123.45"));
            assertThat(rs.getString("note")).isEqualTo("hello");
        }

        // row2 — NULL vs 빈 문자열 구분 (계약의 핵심)
        try (Statement st = conn.createStatement();
             ResultSet rs = st.executeQuery(
                     "SELECT flag, d, amt, note FROM " + schema + ".t WHERE id = 2")) {
            assertThat(rs.next()).isTrue();
            assertThat(rs.getBoolean("flag")).isFalse();
            rs.getDate("d");
            assertThat(rs.wasNull()).as("DuckDB NULL date → PG NULL").isTrue();
            rs.getBigDecimal("amt");
            assertThat(rs.wasNull()).as("DuckDB NULL numeric → PG NULL").isTrue();
            String note = rs.getString("note");
            assertThat(rs.wasNull()).as("빈 문자열은 NULL 이 아니어야 함").isFalse();
            assertThat(note).isEqualTo("");
        }

        // row3 — flag/note NULL, 음수 numeric
        try (Statement st = conn.createStatement();
             ResultSet rs = st.executeQuery(
                     "SELECT flag, d, amt, note FROM " + schema + ".t WHERE id = 3")) {
            assertThat(rs.next()).isTrue();
            rs.getBoolean("flag");
            assertThat(rs.wasNull()).as("DuckDB NULL boolean → PG NULL").isTrue();
            assertThat(rs.getDate("d").toString()).isEqualTo("2023-12-31");
            assertThat(rs.getBigDecimal("amt")).isEqualByComparingTo(new BigDecimal("-0.01"));
            rs.getString("note");
            assertThat(rs.wasNull()).isTrue();
        }
    }

    @Test
    void pgBooleanInput_acceptsYNAnd10_notJustTrueFalse() throws Exception {
        // 도구가 bool 컬럼에 'Y'/'N'/'1'/'0' 문자열을 넘겨도 PG 가 받아들이는지 (계약 문서화).
        try (Statement st = conn.createStatement()) {
            st.execute("CREATE TABLE " + schema + ".b (id INTEGER, flag BOOLEAN)");
        }
        String csv = "1,Y\n2,N\n3,1\n4,0\n5,true\n6,false\n";
        Path f = Files.createTempFile("bool-contract", ".csv");
        try {
            Files.write(f, csv.getBytes(StandardCharsets.UTF_8));
            long rows = copyManager.copyInFromCsv(conn, schema + ".b", f, List.of("id", "flag"));
            assertThat(rows).isEqualTo(6);
        } finally {
            Files.deleteIfExists(f);
        }

        try (Statement st = conn.createStatement();
             ResultSet rs = st.executeQuery("SELECT id, flag FROM " + schema + ".b ORDER BY id")) {
            boolean[] expected = {true, false, true, false, true, false};
            for (boolean exp : expected) {
                assertThat(rs.next()).isTrue();
                assertThat(rs.getBoolean("flag")).as("id=" + rs.getInt("id")).isEqualTo(exp);
            }
        }
    }

    @Test
    void unquotedEmptyIsNull_butQuotedEmptyIntoNumericFails() throws Exception {
        try (Statement st = conn.createStatement()) {
            st.execute("CREATE TABLE " + schema + ".n (id INTEGER, amt NUMERIC)");
        }

        // 따옴표 없는 빈 필드 → NULL (정상)
        Path ok = Files.createTempFile("num-null", ".csv");
        try {
            Files.write(ok, "1,\n".getBytes(StandardCharsets.UTF_8));
            copyManager.copyInFromCsv(conn, schema + ".n", ok, List.of("id", "amt"));
        } finally {
            Files.deleteIfExists(ok);
        }
        try (Statement st = conn.createStatement();
             ResultSet rs = st.executeQuery("SELECT amt FROM " + schema + ".n WHERE id = 1")) {
            assertThat(rs.next()).isTrue();
            rs.getBigDecimal("amt");
            assertThat(rs.wasNull()).as("따옴표 없는 빈 필드 → NULL").isTrue();
        }

        // 따옴표 있는 빈 문자열("") → numeric 캐스팅 실패 (empty↔NULL 계약의 귀결)
        Path bad = Files.createTempFile("num-empty", ".csv");
        try {
            Files.write(bad, "2,\"\"\n".getBytes(StandardCharsets.UTF_8));
            assertThatThrownBy(() ->
                    copyManager.copyInFromCsv(conn, schema + ".n", bad, List.of("id", "amt")))
                    .isInstanceOf(SQLException.class)
                    .hasMessageContaining("invalid input syntax");
        } finally {
            Files.deleteIfExists(bad);
        }
    }
}

package com.ksinfo.modernize_pro_data.coordinator.worker.stages;

import com.ksinfo.modernize_pro_data.coordinator.worker.SqlComposer;
import org.junit.jupiter.api.Test;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.ResultSetMetaData;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * union 방어 가드(B6)의 <b>런타임 경로</b> 실증 — 실제 DuckDB 에서 컬럼 시그니처를 읽어
 * {@link SqlComposer#assertUnionColumnsAligned} 로 검사하는 흐름이
 * {@code TransformStage.assertUnionSourcesAligned} 와 동일하게 동작함을 인메모리 DuckDB 로 확인.
 *
 * (TransformStage 는 Spring @Service 라 단독 인스턴스화가 무거워, 동일한 read+delegate 로직을
 *  여기서 재현해 실 DuckDB 메타데이터 순서/이름 처리까지 검증한다.)
 */
class TransformUnionGuardTest {

    private static Connection duckdb() throws Exception {
        Class.forName("org.duckdb.DuckDBDriver");
        return DriverManager.getConnection("jdbc:duckdb:");
    }

    /** TransformStage.assertUnionSourcesAligned 와 동일한 read+delegate. */
    private static void guard(Connection duck, String schema, List<String> asisTables) throws Exception {
        List<String> tables = new ArrayList<>();
        List<List<String>> signatures = new ArrayList<>();
        try (Statement st = duck.createStatement()) {
            for (String t : asisTables) {
                String fq = q(schema) + "." + q("asis_" + t);
                List<String> cols = new ArrayList<>();
                try (ResultSet rs = st.executeQuery("SELECT * FROM " + fq + " LIMIT 0")) {
                    ResultSetMetaData md = rs.getMetaData();
                    for (int i = 1; i <= md.getColumnCount(); i++) cols.add(md.getColumnLabel(i));
                }
                tables.add(t);
                signatures.add(cols);
            }
        }
        SqlComposer.assertUnionColumnsAligned(tables, signatures);
    }

    private static String q(String s) {
        return "\"" + s.replace("\"", "\"\"") + "\"";
    }

    @Test
    void alignedSources_passThroughRealDuckdb() throws Exception {
        try (Connection duck = duckdb(); Statement st = duck.createStatement()) {
            st.execute("CREATE SCHEMA run_x");
            st.execute("CREATE TABLE run_x.asis_sales_2023 (region VARCHAR, amount INTEGER)");
            st.execute("CREATE TABLE run_x.asis_sales_2024 (region VARCHAR, amount INTEGER)");
            assertDoesNotThrow(() ->
                    guard(duck, "run_x", List.of("sales_2023", "sales_2024")));
        }
    }

    @Test
    void swappedColumnOrder_failsFastViaRealDuckdb() throws Exception {
        try (Connection duck = duckdb(); Statement st = duck.createStatement()) {
            st.execute("CREATE SCHEMA run_x");
            st.execute("CREATE TABLE run_x.asis_a (code VARCHAR, note VARCHAR)");
            st.execute("CREATE TABLE run_x.asis_b (note VARCHAR, code VARCHAR)");  // 순서 뒤바뀜
            IllegalStateException ex = assertThrows(IllegalStateException.class, () ->
                    guard(duck, "run_x", List.of("a", "b")));
            assertTrue(ex.getMessage().contains("silent corruption"), ex.getMessage());
        }
    }

    @Test
    void differentColumnCount_failsFastViaRealDuckdb() throws Exception {
        try (Connection duck = duckdb(); Statement st = duck.createStatement()) {
            st.execute("CREATE SCHEMA run_x");
            st.execute("CREATE TABLE run_x.asis_a (id INTEGER, name VARCHAR)");
            st.execute("CREATE TABLE run_x.asis_b (id INTEGER, name VARCHAR, extra VARCHAR)");
            assertThrows(IllegalStateException.class, () ->
                    guard(duck, "run_x", List.of("a", "b")));
        }
    }
}

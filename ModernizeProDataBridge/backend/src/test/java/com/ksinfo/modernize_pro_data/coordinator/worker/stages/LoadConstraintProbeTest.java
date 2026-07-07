package com.ksinfo.modernize_pro_data.coordinator.worker.stages;

import org.junit.jupiter.api.Test;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.Statement;

import static org.junit.jupiter.api.Assertions.assertEquals;

/**
 * LoadStage final pass 의 FK orphan / CHECK 위반 감지 SQL 의미 검증.
 *   - orphan: 자식 FK 값이 부모에 없는 행만 카운트, NULL FK 는 제외(FK 미적용 의미론).
 *   - check : NOT (expr) 가 FALSE 행만 카운트, NULL(unknown)은 통과라 제외.
 * 표준 SQL 이라 DuckDB/PG 동일 — 여기선 in-memory DuckDB 로 패턴 검증.
 */
class LoadConstraintProbeTest {

    @Test
    void fkOrphanCountsOnlyNonNullMissingParents() throws Exception {
        try (Connection conn = DriverManager.getConnection("jdbc:duckdb:");
             Statement st = conn.createStatement()) {
            st.execute("CREATE TABLE parent (id INTEGER)");
            st.execute("INSERT INTO parent VALUES (1),(2),(3)");
            st.execute("CREATE TABLE child (cust_id INTEGER)");
            // 1,2 존재 / 99 없음(orphan) / 99 또 / NULL(미적용) → orphan = 2
            st.execute("INSERT INTO child VALUES (1),(2),(99),(99),(NULL)");

            String sql = "SELECT count(*) FROM child c WHERE c.\"cust_id\" IS NOT NULL"
                    + " AND NOT EXISTS (SELECT 1 FROM parent p WHERE p.\"id\" = c.\"cust_id\")";
            try (ResultSet rs = st.executeQuery(sql)) {
                rs.next();
                assertEquals(2, rs.getLong(1), "부모 없는 non-NULL 자식 2건만 orphan 으로 카운트");
            }
        }
    }

    @Test
    void checkViolationCountsOnlyFalseRows() throws Exception {
        try (Connection conn = DriverManager.getConnection("jdbc:duckdb:");
             Statement st = conn.createStatement()) {
            st.execute("CREATE TABLE acct (amount INTEGER)");
            // -1,-5 위반(<0) / 0,10 통과 / NULL(unknown→통과) → 위반 2
            st.execute("INSERT INTO acct VALUES (-1),(-5),(0),(10),(NULL)");

            String sql = "SELECT count(*) FROM acct WHERE NOT (amount >= 0)";
            try (ResultSet rs = st.executeQuery(sql)) {
                rs.next();
                assertEquals(2, rs.getLong(1), "CHECK(amount>=0) 위반 2건만 카운트, NULL 은 제외");
            }
        }
    }
}

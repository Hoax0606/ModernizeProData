package com.ksinfo.modernize_pro_data.common.duckdb;

import org.duckdb.DuckDBConnection;
import org.junit.jupiter.api.Test;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;

/**
 * SPIKE: DuckDB memory_limit 이 같은 in-memory DB 를 공유하는 duplicate connection 별로
 * 독립 적용되는지(경로 A), db 인스턴스 전역인지(경로 B) 측정.
 * 출력의 A/B limit 가 다르면 connection별 독립, 같으면 db 전역 공유.
 */
class DuckDbMemoryLimitSpikeTest {

    @Test
    void memoryLimitScope() throws Exception {
        try (DuckDBConnection base =
                     (DuckDBConnection) DriverManager.getConnection("jdbc:duckdb:")) {
            try (Connection a = base.duplicate(); Connection b = base.duplicate()) {
                try (Statement sa = a.createStatement()) { sa.execute("SET memory_limit='1GB'"); }
                try (Statement sb = b.createStatement()) { sb.execute("SET memory_limit='7GB'"); }
                String la = readLimit(a);
                String lb = readLimit(b);
                System.out.println("[spike] A limit=" + la);
                System.out.println("[spike] B limit=" + lb);
                System.out.println("[spike] 격리됨(독립)? " + !la.equals(lb)
                        + "  -> " + (la.equals(lb) ? "경로 B (run별 별도 인스턴스 필요)"
                                                   : "경로 A (connection별 SET 가능)"));
            }
        }
    }

    private String readLimit(Connection c) throws SQLException {
        try (Statement st = c.createStatement();
             ResultSet rs = st.executeQuery(
                     "SELECT value FROM duckdb_settings() WHERE name='memory_limit'")) {
            return rs.next() ? rs.getString(1) : "?";
        }
    }
}

package com.ksinfo.modernize_pro_data.coordinator.load;

import lombok.extern.slf4j.Slf4j;
import org.postgresql.PGConnection;
import org.postgresql.copy.CopyManager;
import org.springframework.stereotype.Service;

import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DriverManager;
import java.util.Map;
import java.util.Properties;

/**
 * PostgreSQL COPY 헬퍼.
 *   - parquet → CSV → COPY FROM stdin
 *   - DuckDB 가 parquet 직접 PostgreSQL 적재 못 하므로 중간 CSV 파일을 거침
 *   - TO-BE PostgreSQL 의 CopyManager 활용 (가장 빠른 적재 방법)
 *
 * Load stage 가 호출. PoC 1차 — 단일 TO-BE 환경 (site.tobeDbByEnv[env]).
 */
@Service
@Slf4j
public class PgCopyManager {

    /**
     * site.tobeDbByEnv[env] map 으로부터 JDBC Connection 오픈.
     * caller 가 close() 책임.
     */
    public Connection openConnection(Map<String, Object> dbConfig) throws Exception {
        String host = (String) dbConfig.get("host");
        Object portObj = dbConfig.get("port");
        String database = (String) dbConfig.get("database");
        String username = (String) dbConfig.get("username");
        String password = (String) dbConfig.get("password");
        if (host == null || database == null) {
            throw new IllegalStateException("host or database missing in tobe DB config");
        }
        int port = portObj instanceof Number ? ((Number) portObj).intValue()
                : portObj instanceof String ? Integer.parseInt((String) portObj) : 5432;

        String url = "jdbc:postgresql://" + host + ":" + port + "/" + database;
        Properties props = new Properties();
        if (username != null) props.setProperty("user", username);
        if (password != null) props.setProperty("password", password);
        return DriverManager.getConnection(url, props);
    }

    /**
     * TRUNCATE 대상 테이블 — 재실행 가능하도록 기존 데이터 지움.
     */
    public void truncate(Connection conn, String schemaQualifiedTable) throws Exception {
        try (var st = conn.createStatement()) {
            st.executeUpdate("TRUNCATE TABLE " + schemaQualifiedTable);
        }
    }

    /**
     * CSV 파일 → PostgreSQL COPY FROM stdin.
     * returns: 적재한 row 수.
     */
    public long copyInFromCsv(Connection conn, String schemaQualifiedTable, Path csvFile) throws Exception {
        PGConnection pg = conn.unwrap(PGConnection.class);
        CopyManager copyManager = pg.getCopyAPI();
        String sql = "COPY " + schemaQualifiedTable + " FROM stdin (FORMAT csv, HEADER false)";
        try (InputStream in = Files.newInputStream(csvFile)) {
            long rows = copyManager.copyIn(sql, in);
            log.info("PG COPY {} ← {} : {} rows", schemaQualifiedTable, csvFile, rows);
            return rows;
        }
    }
}

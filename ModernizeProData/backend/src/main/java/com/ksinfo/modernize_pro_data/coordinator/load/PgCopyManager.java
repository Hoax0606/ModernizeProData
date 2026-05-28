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
import java.util.List;
import java.util.Map;
import java.util.Properties;
import java.util.stream.Collectors;

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
     * FK/trigger 비활성화 시도 — session_replication_role=replica (대량 적재 시 FK 순서·속도 문제 회피).
     * superuser 권한이 필요하므로 권한 없으면 경고만 남기고 skip (false 반환) → FK 켠 채 정상 적재.
     * 성공(true) 시 caller 가 적재 후 {@link #restoreConstraints} 호출.
     * 주의: replica 모드여도 NOT NULL / CHECK 는 그대로 강제됨 (FK·user trigger 만 off).
     */
    public boolean tryDisableConstraints(Connection conn) {
        try (var st = conn.createStatement()) {
            st.execute("SET session_replication_role = replica");
            return true;
        } catch (Exception e) {
            log.warn("FK 비활성화 skip — session_replication_role 설정 실패 (권한 없음?): {}", e.getMessage());
            return false;
        }
    }

    /** session_replication_role 을 origin 으로 복귀 (tryDisableConstraints 가 true 였을 때만 호출). */
    public void restoreConstraints(Connection conn) {
        try (var st = conn.createStatement()) {
            st.execute("SET session_replication_role = origin");
        } catch (Exception e) {
            log.warn("session_replication_role 복귀 실패: {}", e.getMessage());
        }
    }

    /** 컬럼 리스트 없이 적재 (positional). 가능하면 명시 오버로드 사용 권장. */
    public long copyInFromCsv(Connection conn, String schemaQualifiedTable, Path csvFile) throws Exception {
        return copyInFromCsv(conn, schemaQualifiedTable, csvFile, null);
    }

    /**
     * CSV 파일 → PostgreSQL COPY FROM stdin. returns: 적재한 row 수.
     * columns 가 주어지면 명시적 컬럼 리스트로 COPY — CSV 필드 순서를 컬럼 이름에 매핑하므로
     * 대상 테이블의 DDL ordinal 과 무관하게 정확히 들어간다 (positional 오정렬 방지).
     * CSV 필드 순서와 columns 순서는 반드시 동일해야 한다 (caller 책임).
     */
    public long copyInFromCsv(Connection conn, String schemaQualifiedTable, Path csvFile,
                              List<String> columns) throws Exception {
        PGConnection pg = conn.unwrap(PGConnection.class);
        CopyManager copyManager = pg.getCopyAPI();
        String colList = (columns == null || columns.isEmpty()) ? ""
                : " (" + columns.stream()
                        .map(c -> "\"" + c.replace("\"", "\"\"") + "\"")
                        .collect(Collectors.joining(", ")) + ")";
        String sql = "COPY " + schemaQualifiedTable + colList + " FROM stdin (FORMAT csv, HEADER false)";
        try (InputStream in = Files.newInputStream(csvFile)) {
            long rows = copyManager.copyIn(sql, in);
            log.info("PG COPY {}{} ← {} : {} rows", schemaQualifiedTable, colList, csvFile, rows);
            return rows;
        }
    }
}

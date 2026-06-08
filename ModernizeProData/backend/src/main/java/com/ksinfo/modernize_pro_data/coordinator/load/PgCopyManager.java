package com.ksinfo.modernize_pro_data.coordinator.load;

import lombok.extern.slf4j.Slf4j;
import org.postgresql.PGConnection;
import org.postgresql.copy.CopyManager;
import org.postgresql.copy.PGCopyOutputStream;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.ResultSetMetaData;
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
     * Bulk load connection 의 session-level 튜닝 (서버 config·restart·superuser 불필요).
     *  - synchronous_commit=off: COPY 한 방엔 commit 1회라 효과는 작지만 free.
     *  - maintenance_work_mem↑: 적재 후 PK 인덱스 빌드(ensurePkIndex CONCURRENTLY) 가속.
     * 서버 레벨(max_wal_size/shared_buffers/checkpoint_timeout)은 도구가 못 건드림 — TO-BE PG
     * DBA 가 postgresql.conf 로. (임의 고객 PG 서버 config 를 도구가 바꾸지 않는다.)
     */
    @Value("${modernize.load.synchronous-commit-off:true}")
    private boolean syncCommitOff;

    @Value("${modernize.load.maintenance-work-mem:512MB}")
    private String maintenanceWorkMem;

    /**
     * site.tobeDbByEnv[env] map 으로부터 JDBC Connection 오픈.
     * caller 는 반드시 try-with-resources 로 wrap (leak 방지).
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
        Connection conn = DriverManager.getConnection(url, props);
        applyLoadSessionTuning(conn);
        return conn;
    }

    /** 적재 connection 에 session-level 튜닝 적용. 실패해도 적재 자체엔 영향 없음 (best-effort). */
    private void applyLoadSessionTuning(Connection conn) {
        try (var st = conn.createStatement()) {
            if (syncCommitOff) {
                st.execute("SET synchronous_commit = off");
            }
            if (maintenanceWorkMem != null && !maintenanceWorkMem.isBlank()) {
                st.execute("SET maintenance_work_mem = '" + maintenanceWorkMem.replace("'", "''") + "'");
            }
        } catch (Exception e) {
            log.warn("load session tuning skip: {}", e.getMessage());
        }
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
        String colList = buildColumnList(columns);
        String sql = "COPY " + schemaQualifiedTable + colList + " FROM stdin (FORMAT csv, HEADER false)";
        try (InputStream in = Files.newInputStream(csvFile)) {
            long rows = copyManager.copyIn(sql, in);
            log.info("PG COPY {}{} ← {} : {} rows", schemaQualifiedTable, colList, csvFile, rows);
            return rows;
        }
    }

    /**
     * DuckDB ResultSet → PG COPY FROM STDIN 직접 streaming. 중간 CSV 파일 X.
     *
     * <p>흐름: caller 가 DuckDB SELECT 의 ResultSet 을 open 한 상태로 넘김. 이
     * 메서드가 row 마다 CSV 직렬화 → {@link PGCopyOutputStream} 으로 write.
     * 대용량 (수십 GB) 에서 디스크 IO 우회로 40~60% 단축 기대.
     *
     * <p>CSV format = PG default (RFC 4180-ish). NULL = unquoted empty field
     * (CSV 모드 default). 빈 문자열은 quoted `""` 로 NULL 과 구분.
     *
     * <p>caller 책임:
     * <ul>
     *   <li>ResultSet 의 컬럼 순서와 {@code columns} 의 순서 일치.</li>
     *   <li>ResultSet 의 fetch size 적절 (DuckDB JDBC 의 기본은 streaming).</li>
     *   <li>ResultSet / Connection 의 lifecycle 관리 (이 메서드는 close 안 함).</li>
     * </ul>
     */
    public long copyInFromResultSet(Connection conn, String schemaQualifiedTable,
                                    List<String> columns, ResultSet rs) throws Exception {
        return copyInFromResultSet(conn, schemaQualifiedTable, columns, rs, () -> false);
    }

    /**
     * cancel 가능 오버로드 (2026-06-04). {@code cancelled} 가 true 가 되면 row 루프를
     * 4096행마다 검사해 {@link java.util.concurrent.CancellationException} 을 던진다.
     * caller 의 try-with-resources 가 PG Connection 을 닫으면 서버가 진행 중 COPY 를
     * abort → Stop 버튼이 stage 완료를 기다리지 않고 수 초 내 반응. (이전엔 cancel 이
     * stage 경계에서만 검사돼 1M행 COPY 중엔 안 멈췄음.)
     */
    public long copyInFromResultSet(Connection conn, String schemaQualifiedTable,
                                    List<String> columns, ResultSet rs,
                                    java.util.function.BooleanSupplier cancelled) throws Exception {
        PGConnection pg = conn.unwrap(PGConnection.class);
        String colList = buildColumnList(columns);
        String sql = "COPY " + schemaQualifiedTable + colList + " FROM stdin (FORMAT csv, HEADER false)";

        ResultSetMetaData md = rs.getMetaData();
        int colCount = md.getColumnCount();
        long rows = 0;
        // 8KB chunk — small enough to flush often, big enough to avoid syscall churn.
        StringBuilder line = new StringBuilder(256);
        try (PGCopyOutputStream out = new PGCopyOutputStream(pg, sql, 65536)) {
            while (rs.next()) {
                // 취소 검사 — 4096행마다 (검사 비용 무시 가능). 취소 시 throw → caller 가
                // conn.close() → 서버가 in-flight COPY rollback.
                if ((rows & 0xFFF) == 0 && cancelled.getAsBoolean()) {
                    throw new java.util.concurrent.CancellationException(
                            "load cancelled after " + rows + " rows into " + schemaQualifiedTable);
                }
                line.setLength(0);
                for (int i = 1; i <= colCount; i++) {
                    if (i > 1) line.append(',');
                    appendCsvField(line, rs.getObject(i));
                }
                line.append('\n');
                out.write(line.toString().getBytes(StandardCharsets.UTF_8));
                rows++;
            }
            out.flush();
        }
        log.info("PG COPY {}{} ← <duckdb stream> : {} rows", schemaQualifiedTable, colList, rows);
        return rows;
    }

    /** Build the quoted column list suffix, or empty string when no columns specified. */
    private static String buildColumnList(List<String> columns) {
        if (columns == null || columns.isEmpty()) return "";
        return " (" + columns.stream()
                .map(c -> "\"" + c.replace("\"", "\"\"") + "\"")
                .collect(Collectors.joining(", ")) + ")";
    }

    /**
     * Append one value to a CSV line.
     * <ul>
     *   <li>{@code null} → empty unquoted field. PG CSV default NULL representation.</li>
     *   <li>empty String → {@code ""} (quoted empty). Distinguishes empty string from NULL.</li>
     *   <li>otherwise → quote only when the value contains {@code , " \r \n}.
     *       Inner {@code "} doubled per RFC 4180.</li>
     * </ul>
     */
    private static void appendCsvField(StringBuilder sb, Object v) {
        if (v == null) return;
        String s = v.toString();
        if (s.isEmpty()) {
            sb.append("\"\"");
            return;
        }
        boolean needQuote = false;
        for (int i = 0, n = s.length(); i < n; i++) {
            char c = s.charAt(i);
            if (c == ',' || c == '"' || c == '\n' || c == '\r') {
                needQuote = true;
                break;
            }
        }
        if (needQuote) {
            sb.append('"');
            sb.append(s.replace("\"", "\"\""));
            sb.append('"');
        } else {
            sb.append(s);
        }
    }
}

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
     *  - synchronous_commit=off: **기본 비활성(false)**. 이 워크로드는 테이블당 COPY 1방 = commit
     *    1회라 fsync 1회만 아껴 효과 거의 없음(<5% 예상). 게다가 commit ack 후 fsync 전 crash 시 마지막
     *    commit 유실 가능 → durability 손상. rehearsal/test 에서만 명시 opt-in, **cutover 는 절대 끄지
     *    않음**(production 전환 — 정확성 > 속도, LoadStage 가 allowSyncCommitOff=false 로 강제).
     *  - maintenance_work_mem↑: 적재 후 PK 인덱스 빌드(ensurePkIndex CONCURRENTLY) 가속. real 효과 — 항상.
     * 서버 레벨(max_wal_size/shared_buffers/checkpoint_timeout)은 도구가 못 건드림 — TO-BE PG
     * DBA 가 postgresql.conf 로. (임의 고객 PG 서버 config 를 도구가 바꾸지 않는다.)
     */
    @Value("${modernize.load.synchronous-commit-off:false}")
    private boolean syncCommitOff;

    @Value("${modernize.load.maintenance-work-mem:512MB}")
    private String maintenanceWorkMem;

    /**
     * site.tobeDbByEnv[env] map 으로부터 JDBC Connection 오픈.
     * caller 는 반드시 try-with-resources 로 wrap (leak 방지).
     */
    public Connection openConnection(Map<String, Object> dbConfig) throws Exception {
        return openConnection(dbConfig, true);
    }

    /**
     * {@code allowSyncCommitOff}=false 면 config 가 켜져있어도 synchronous_commit 을 끄지 않는다.
     * LoadStage 가 cutover run 에서 false 를 넘겨 production durability 를 보장한다.
     */
    public Connection openConnection(Map<String, Object> dbConfig, boolean allowSyncCommitOff) throws Exception {
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
        applyLoadSessionTuning(conn, allowSyncCommitOff);
        return conn;
    }

    /** 적재 connection 에 session-level 튜닝 적용. 실패해도 적재 자체엔 영향 없음 (best-effort). */
    private void applyLoadSessionTuning(Connection conn, boolean allowSyncCommitOff) {
        try (var st = conn.createStatement()) {
            // synchronous_commit=off 는 config 켜짐 + caller 가 허용(=cutover 아님) 일 때만.
            if (syncCommitOff && allowSyncCommitOff) {
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

    /**
     * CDC 델타 병합 — ResultSet(변환된 델타, op-type 컬럼 포함)을 TEMP staging 으로 COPY 한 뒤
     * PK 기준 <b>upsert(op=I/U) + delete(op=D)</b>. 타깃을 TRUNCATE 하지 않는다.
     *
     * <p>원자성: {@code autoCommit=off} → staging COPY + upsert + delete 를 한 트랜잭션으로 commit,
     * 실패 시 rollback. staging 은 TEMP(세션 격리) 이며 명시 DROP + 연결 종료 시 자동 소멸.
     *
     * <p>전제: 타깃 테이블과 <b>PK 인덱스가 사전 존재</b>해야 함(ON CONFLICT 요구) — 초기 전량적재가
     * 만들어 둔다. {@code allColumns} 는 델타 행의 전체 컬럼 이미지라는 계약 위에서 정확하다.
     *
     * @return staging 으로 들어온 델타 row 수.
     */
    public long mergeFromResultSet(Connection conn, String qualifiedTarget,
                                   List<String> allColumns, String opColumn, List<String> pkColumns,
                                   ResultSet rs, java.util.function.BooleanSupplier cancelled) throws Exception {
        if (pkColumns == null || pkColumns.isEmpty()) {
            throw new IllegalStateException("delta merge requires a primary key: " + qualifiedTarget);
        }
        List<String> dataCols = allColumns.stream().filter(c -> !c.equals(opColumn)).collect(Collectors.toList());
        List<String> nonPk = dataCols.stream().filter(c -> !pkColumns.contains(c)).collect(Collectors.toList());
        String staging = "\"__delta_staging\"";   // TEMP (세션 격리) — 연결당 1 테이블 병합

        boolean prevAuto = conn.getAutoCommit();
        conn.setAutoCommit(false);
        long rows;
        try {
            try (var st = conn.createStatement()) {
                st.execute("DROP TABLE IF EXISTS " + staging);
                // 타깃 구조 복제(데이터 컬럼·타입) + op-type 제어 컬럼. 제약/인덱스는 복제 안 함.
                st.execute("CREATE TEMP TABLE " + staging + " (LIKE " + qualifiedTarget + " INCLUDING DEFAULTS)");
                st.execute("ALTER TABLE " + staging + " ADD COLUMN " + q(opColumn) + " text");
            }
            // staging 으로 COPY (데이터 컬럼 + op 컬럼, ResultSet 순서 그대로). COPY 스트림 재사용.
            rows = copyInFromResultSet(conn, staging, allColumns, rs, cancelled);

            String cols = dataCols.stream().map(PgCopyManager::q).collect(Collectors.joining(", "));
            String conflict = pkColumns.stream().map(PgCopyManager::q).collect(Collectors.joining(", "));
            String upsert = "INSERT INTO " + qualifiedTarget + " (" + cols + ") "
                    + "SELECT " + cols + " FROM " + staging + " WHERE " + q(opColumn) + " IN ('I','U') "
                    + "ON CONFLICT (" + conflict + ") "
                    + (nonPk.isEmpty()
                        ? "DO NOTHING"
                        : "DO UPDATE SET " + nonPk.stream()
                            .map(c -> q(c) + " = EXCLUDED." + q(c))
                            .collect(Collectors.joining(", ")));
            String joinCond = pkColumns.stream()
                    .map(c -> "t." + q(c) + " = s." + q(c))
                    .collect(Collectors.joining(" AND "));
            String delete = "DELETE FROM " + qualifiedTarget + " t USING " + staging + " s "
                    + "WHERE s." + q(opColumn) + " = 'D' AND " + joinCond;
            try (var st = conn.createStatement()) {
                int upserted = st.executeUpdate(upsert);
                int deleted = st.executeUpdate(delete);
                st.execute("DROP TABLE IF EXISTS " + staging);
                log.info("PG delta merge {} : {} delta rows (upsert~{}, delete {})",
                        qualifiedTarget, rows, upserted, deleted);
            }
            conn.commit();
        } catch (Exception e) {
            try { conn.rollback(); } catch (Exception ignore) { /* best-effort */ }
            throw e;
        } finally {
            try { conn.setAutoCommit(prevAuto); } catch (Exception ignore) { /* best-effort */ }
        }
        return rows;
    }

    /** Quote a single identifier for SQL (double-quote, inner {@code "} doubled). */
    private static String q(String ident) {
        return "\"" + ident.replace("\"", "\"\"") + "\"";
    }

    /** Build the quoted column list suffix, or empty string when no columns specified. */
    private static String buildColumnList(List<String> columns) {
        if (columns == null || columns.isEmpty()) return "";
        return " (" + columns.stream()
                .map(c -> "\"" + c.replace("\"", "\"\"") + "\"")
                .collect(Collectors.joining(", ")) + ")";
    }

    /**
     * Append one value to a CSV line — the tool's load-time type serialization contract.
     * The text produced here is what PG COPY {@code (FORMAT csv)} parses back into the
     * target column type, so the rules below define the empty↔NULL / bool / date contract:
     * <ul>
     *   <li>{@code null} → empty unquoted field → PG interprets as <b>NULL</b>
     *       (PG CSV default NULL representation, an unquoted empty string).</li>
     *   <li>empty {@code String} → {@code ""} (quoted empty) → PG interprets as an
     *       <b>empty string</b>, NOT NULL. This is the one case that distinguishes the two.
     *       Consequence: a Java empty string into a non-text column (numeric/date/bool)
     *       makes COPY fail ("invalid input syntax") — the Transform stage must emit NULL
     *       (e.g. {@code NULLIF(col,'')}) for such columns, not an empty string.</li>
     *   <li>otherwise → {@code v.toString()}, quoted only when it contains {@code , " \r \n}
     *       (inner {@code "} doubled per RFC 4180). Type text comes straight from the JDBC
     *       driver's object rendering: {@code Boolean}→{@code "true"/"false"} (PG bool also
     *       accepts y/n/1/0/t/f), {@code java.sql.Date}/{@code LocalDate}→{@code "yyyy-MM-dd"},
     *       {@code BigDecimal}→plain decimal. No locale/format massaging is applied here.</li>
     * </ul>
     * Package-private (not private) so {@code PgCopyManagerCsvFieldTest} can lock this contract.
     * 실제 규칙은 {@link CsvFieldSerializer#append} 에 있다 (PG COPY / Oracle sqlldr 공유 — drift 방지).
     */
    static void appendCsvField(StringBuilder sb, Object v) {
        CsvFieldSerializer.append(sb, v);
    }
}

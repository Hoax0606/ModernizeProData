package com.ksinfo.modernize_pro_data.common.duckdb;

import com.ksinfo.modernize_pro_data.common.duckdb.udf.UdfRegistry;
import jakarta.annotation.PreDestroy;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import java.io.File;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;

/**
 * DuckDB 임베디드 서비스.
 *
 * 변환·검증 SQL 을 실행하는 핵심 엔진. Worker 와 Coordinator 양쪽에서
 * 같은 방식으로 사용한다.
 *
 * 사용 예:
 *   try (Statement st = duckDbService.statement()) {
 *       ResultSet rs = st.executeQuery(
 *           "SELECT COUNT(*) FROM read_csv('asis.csv', encoding='shift_jis')"
 *       );
 *       ...
 *   }
 *
 * 현재는 단일 연결 (in-memory 또는 file). 다중 연결·풀링은 향후 worker 작업
 * 동시성 요구에 따라 추가.
 */
@Slf4j
@Service
public class DuckDbService {

    @Value("${modernize.duckdb.memory-mode:true}")
    private boolean memoryMode;

    @Value("${modernize.duckdb.file-path:./data/duckdb.db}")
    private String filePath;

    @Value("${modernize.duckdb.temp-directory:./data/duckdb-tmp}")
    private String tempDirectory;

    /**
     * perf flag — false 면 lock 계측 자체 진입 없음 (분기 false 한 줄). true 면
     * waitMs (lock 대기) / holdMs (lock 점유) 측정. application-dev.yml 만 true.
     */
    @Value("${modernize.perf.enabled:false}")
    private boolean perfEnabled;

    private Connection connection;

    /**
     * run 실행 thread 별 격리 connection (per-run). bindRunConnection 으로 set, unbind 로 close.
     * null 이면 (사용자 요청 외 경로 / 테스트) 공유 connection 사용.
     *
     * 왜: run stage 들은 같은 단일 공유 connection 의 statement() 를 썼다. 동시 2개 run 이
     * 같은 connection 에서 한쪽이 ResultSet 읽는 중 다른 쪽이 execute → DuckDB JDBC 의
     * pending result 가 무효화돼 "Attempting to execute an unsuccessful or closed pending
     * query result" 로 깨졌다 (6개 동시 실행 시 재현, 1개씩이면 안 겹쳐서 정상). run 마다
     * 별 thread(@Async) 라 ThreadLocal 로 run 전용 connection 을 묶으면 stage 코드 변경 없이
     * statement() 가 자동으로 격리 connection 을 반환한다. 같은 in-memory DB 인스턴스를 공유
     * (duplicate)하므로 run 별 schema 데이터는 그대로 보인다.
     */
    private final ThreadLocal<Connection> runScoped = new ThreadLocal<>();

    public Connection getConnection() throws SQLException {
        long t0 = perfEnabled ? System.nanoTime() : 0L;
        final Connection c;
        synchronized (this) {
            long t1 = perfEnabled ? System.nanoTime() : 0L;
            if (connection == null || connection.isClosed()) {
                // 파일 모드면 부모 디렉토리 보장 — DuckDB 가 자체 생성 안 함.
                // jpackage 첫 설치 환경처럼 cwd 아래 data/ 가 없으면 IO Error 로 startup fail.
                if (!memoryMode) {
                    try {
                        Path parent = Path.of(filePath).toAbsolutePath().getParent();
                        if (parent != null) Files.createDirectories(parent);
                    } catch (Exception e) {
                        log.warn("DuckDB file-path 부모 디렉토리 생성 실패 {} : {}", filePath, e.getMessage());
                    }
                }
                String url = memoryMode ? "jdbc:duckdb:" : "jdbc:duckdb:" + filePath;
                connection = DriverManager.getConnection(url);
                log.info("DuckDB connection opened: {}", url);
                // DuckDB 의 UDF 는 connection 별로 등록 — 새 connection 마다 일괄 register.
                UdfRegistry.registerAll(connection);
                // encodings 확장은 제거됨 (2026-07-08 UTF-8 입력 계약) — read_csv 는 UTF-8 native 로만 읽는다.
                // icu 확장 — '+09:00' 같은 timezone offset 인식 (TransformStage 의 TIMESTAMPTZ CAST / STRPTIME).
                // 없으면 DuckDB 가 'Unknown TimeZone "+09:00"' 로 reject → Transform / Audit / Load / Verify cascade ERROR.
                loadIcuExtension(connection);
                // 대용량 spill — operator(JOIN/sort/aggregation) + 파일모드 테이블 RAM 초과분 디스크로.
                configureSpill(connection);
            }
            c = connection;
            if (perfEnabled) {
                long t2 = System.nanoTime();
                long waitMs = (t1 - t0) / 1_000_000;
                long holdMs = (t2 - t1) / 1_000_000;
                // noise floor — 일상적 cached connection 반환 (수십 μs) 은 무시.
                if (waitMs > 5 || holdMs > 100) {
                    log.info("[perf] duckdb.lock waitMs={} holdMs={}", waitMs, holdMs);
                }
            }
        }
        return c;
    }

    /**
     * 대용량 OOM 내성 — temp_directory 지정 (RAM 초과분 디스크 spill 위치).
     * memory_limit 은 미설정 → DuckDB 기본(= RAM 80% 자동)에 위임 (현장 RAM 불명).
     * 파일 모드(prod)면 테이블도, in-memory(dev)면 연산자 중간결과가 여기로 spill.
     */
    private void configureSpill(Connection conn) {
        try {
            Files.createDirectories(Path.of(tempDirectory));
        } catch (Exception e) {
            log.warn("DuckDB temp_directory 생성 실패 {} : {}", tempDirectory, e.getMessage());
        }
        String escaped = tempDirectory.replace("\\", "/").replace("'", "''");
        try (Statement st = conn.createStatement()) {
            st.execute("SET temp_directory = '" + escaped + "'");
            log.info("DuckDB temp_directory set: {} (memory_limit=default ~80% RAM)", tempDirectory);
        } catch (SQLException e) {
            log.warn("DuckDB temp_directory 설정 실패: {}", e.getMessage());
        }
    }

    /**
     * run 시작 시 호출 — 남아있는 run_* 작업 schema 를 정리 (이전/크래시 찌꺼기 + clean slate).
     * keepSchemas (현재 running/pending 인 run 의 schema) 는 보존 → 동시 run 안전.
     * 지우는 건 DuckDB 내부 임시 작업 테이블뿐 — 메타DB·TO-BE DB·Parquet 산출물 무관.
     */
    public synchronized void sweepRunSchemas(Set<String> keepSchemas) {
        long t0 = perfEnabled ? System.nanoTime() : 0L;
        List<String> toDrop = new ArrayList<>();
        try (Statement st = statement();
             ResultSet rs = st.executeQuery(
                     "SELECT schema_name FROM information_schema.schemata "
                   + "WHERE schema_name LIKE 'run\\_%' ESCAPE '\\'")) {
            while (rs.next()) {
                String s = rs.getString(1);
                if (keepSchemas == null || !keepSchemas.contains(s)) toDrop.add(s);
            }
        } catch (SQLException e) {
            log.warn("DuckDB run schema sweep 조회 실패: {}", e.getMessage());
            return;
        }
        for (String s : toDrop) {
            try (Statement st = statement()) {
                st.execute("DROP SCHEMA IF EXISTS \"" + s.replace("\"", "\"\"") + "\" CASCADE");
            } catch (SQLException e) {
                log.warn("DuckDB run schema drop 실패 {} : {}", s, e.getMessage());
            }
        }
        if (!toDrop.isEmpty()) {
            log.info("DuckDB run schema swept — {} dropped, {} kept (active)",
                    toDrop.size(), keepSchemas == null ? 0 : keepSchemas.size());
        }
        if (perfEnabled) {
            long elapsedMs = (System.nanoTime() - t0) / 1_000_000;
            log.info("[perf] duckdb.sweep elapsedMs={} dropped={} kept={}",
                    elapsedMs, toDrop.size(), keepSchemas == null ? 0 : keepSchemas.size());
        }
    }

    /**
     * 폐쇄망용 — 인스톨러 staging 의 duckdb-extensions/ 디렉토리 경로 resolve.
     * jpackage 의 $APPDIR/app/duckdb-extensions/{name}.duckdb_extension. 없으면 (dev mode)
     * null 반환 → INSTALL 의 인터넷 다운로드 fallback.
     */
    private static File resolveBundledExtension(String name) {
        String javaHome = System.getProperty("java.home");
        if (javaHome == null) return null;
        File runtime = new File(javaHome);
        File appDir = runtime.getParentFile();
        if (appDir == null) return null;
        File ext = new File(appDir, "app/duckdb-extensions/" + name + ".duckdb_extension");
        return ext.isFile() ? ext : null;
    }

    /**
     * DuckDB icu 확장 로드 — timezone offset 인식. {@code TIMESTAMP WITH TIME ZONE} CAST 또는
     * '+09:00' 같은 offset 포함 timestamp 문자열 파싱에 필요. 없으면
     * "Conversion Error: Unknown TimeZone '+09:00'!" 로 reject 됨.
     */
    private void loadIcuExtension(Connection conn) {
        loadBundledOrRemote(conn, "icu", "timezone 포함 timestamp 파싱 불가");
    }

    /**
     * 단일 extension load 의 공통 path. 1) 인스톨러 동봉 binary 가 있으면 그것 LOAD '<path>'
     * 직접 (폐쇄망), 2) 없으면 INSTALL + LOAD 의 인터넷 다운로드 (dev mode).
     */
    private void loadBundledOrRemote(Connection conn, String name, String impactHint) {
        File bundled = resolveBundledExtension(name);
        try (Statement st = conn.createStatement()) {
            if (bundled != null) {
                String escaped = bundled.getAbsolutePath().replace("\\", "/").replace("'", "''");
                st.execute("LOAD '" + escaped + "'");
                log.info("DuckDB {} extension loaded from bundled binary ({})", name, escaped);
                return;
            }
            st.execute("INSTALL " + name);
            st.execute("LOAD " + name);
            log.info("DuckDB {} extension loaded (remote install)", name);
        } catch (SQLException e) {
            log.warn("DuckDB {} extension 로드 실패 — {} (폐쇄망이면 확장 바이너리 동봉 필요): {}",
                    name, impactHint, e.getMessage());
        }
    }

    public Statement statement() throws SQLException {
        // run thread 에 격리 connection 이 바인딩돼 있으면 그것을, 아니면 공유 connection 을 쓴다.
        Connection rc = runScoped.get();
        return (rc != null ? rc : getConnection()).createStatement();
    }

    /**
     * 현재 thread 에 그 run 전용 격리 connection 을 바인딩. 이후 이 thread 의 statement() 호출은
     * 모두 이 connection 을 쓴다 (run 간 공유 connection 동시 사용 충돌 회피). unbindRunConnection 과 짝.
     * 같은 thread 에서 중복 호출되면 무시 (재진입 방어 — 기존 connection 유지).
     */
    public void bindRunConnection(String memoryLimit, String runTempDir) {
        if (runScoped.get() != null) return;
        try {
            // file-mode(prod): run 전용 file-backed DuckDB (run.duckdb). 테이블이 디스크에
            // materialize 되고 RAM 은 memory_limit(버퍼풀)로 상한 → 동시 다중 run 이 RAM 을
            // 다 먹어 batch 거듭될수록 느려지던 문제 해결. run 마다 독립 파일이라 격리도 유지.
            // memory-mode(dev): in-memory 유지.
            String dbFile = null;
            if (!memoryMode && runTempDir != null && !runTempDir.isBlank()) {
                try { Files.createDirectories(Path.of(runTempDir)); } catch (Exception ignore) { /* SET 단계서 재실패 시 처리 */ }
                dbFile = runTempDir.replace("\\", "/") + "/run.duckdb";
            }
            Connection c = openRunInstance(dbFile);
            try (Statement st = c.createStatement()) {
                if (memoryLimit != null && !memoryLimit.isBlank()) {
                    st.execute("SET memory_limit='" + memoryLimit.replace("'", "''") + "'");
                }
                String tmp = (runTempDir != null && !runTempDir.isBlank()) ? runTempDir : tempDirectory;
                try { Files.createDirectories(Path.of(tmp)); } catch (Exception ignore) { /* 권한/IO — SET 단계서 재실패 시 무시 */ }
                st.execute("SET temp_directory='" + tmp.replace("\\", "/").replace("'", "''") + "'");
            }
            runScoped.set(c);
            log.info("run-scoped DuckDB connection bound (memoryMode={} dbFile={} memory_limit={})",
                    memoryMode, dbFile, memoryLimit);
        } catch (Exception e) {
            // 바인딩 실패해도 statement() 가 공유 connection 으로 폴백 — run 진행 자체는 가능.
            log.warn("run-scoped DuckDB connection 바인딩 실패 — 공유 connection 폴백: {}", e.getMessage());
        }
    }

    /**
     * run 전용 독립 DuckDB 인스턴스. dbFile=null 이면 in-memory, 아니면 file-backed(run.duckdb).
     * 확장(icu)·UDF 를 새 인스턴스에 재등록. (encodings 확장은 제거 — UTF-8 입력 계약.)
     */
    private Connection openRunInstance(String dbFile) throws SQLException {
        String url = (dbFile == null || dbFile.isBlank()) ? "jdbc:duckdb:" : "jdbc:duckdb:" + dbFile;
        Connection c = DriverManager.getConnection(url);
        UdfRegistry.registerAll(c);
        loadIcuExtension(c);
        return c;
    }

    /** 현재 thread 에 바인딩된 run-scoped connection (없으면 null). RunExecutionListener 가 ctx 로 전달. */
    public Connection currentRunConnection() {
        return runScoped.get();
    }

    /**
     * 주어진 src connection 과 같은 DuckDB 인스턴스를 바라보는 새 connection 을 duplicate.
     * src 가 null 이면 공유 base. LoadStage 의 병렬 Future thread 가 ctx 의 run connection 을
     * 넘겨 run 전용 인스턴스의 데이터를 조회할 때 쓴다 (그 thread 엔 ThreadLocal 이 없으므로).
     * caller 가 close() 책임.
     */
    public Connection duplicateOf(Connection src) throws SQLException {
        synchronized (this) {
            Connection base = (src != null) ? src : getConnection();
            return ((org.duckdb.DuckDBConnection) base).duplicate();
        }
    }

    /** 현재 thread 의 run-scoped connection 을 제거 + close. @Async 풀 thread 재사용 시 누수 방지 위해 finally 에서 호출 필수. */
    public void unbindRunConnection() {
        Connection c = runScoped.get();
        runScoped.remove();
        if (c != null) {
            try { c.close(); } catch (SQLException e) { log.warn("run-scoped DuckDB connection close 실패: {}", e.getMessage()); }
        }
    }

    /**
     * 사용자 요청 (Mapping Report / Trial / CSV preview) 용 요청별 격리 connection.
     *
     * 공유 connection 은 한 쿼리의 ResultSet 을 읽는 중 다른 스레드가 쿼리를 실행하면
     * pending result 가 무효화돼 "Attempting to execute an unsuccessful or closed
     * pending query result" 가 난다 (2026-06-04 — 다중 사용자 Report 동시 실행에서 발생).
     * duplicate() + UDF 등록으로 요청마다 독립 세션을 쓴다. caller 가 close() 책임.
     */
    public Connection requestConnection() throws SQLException {
        // Report/Trial/preview 는 read_csv(AS-IS 파일) 직접이라 공유 db 데이터가 필요 없다.
        // base.duplicate() 는 같은 인스턴스를 공유해 동시 요청 시 pending result 가 무효화된다
        // → 독립 in-memory 인스턴스로 완전 격리 (file-mode 다중 프로젝트 동시 Report 충돌 해소).
        Connection c = DriverManager.getConnection("jdbc:duckdb:");
        try {
            UdfRegistry.registerAll(c);
            loadIcuExtension(c);
        } catch (Exception e) {
            // 확장/UDF 등록 실패해도 connection 자체는 사용 가능.
            log.warn("DuckDB 확장/UDF 등록 실패 (request connection): {}", e.getMessage());
        }
        return c;
    }

    /**
     * 도구 기동 시점에 호출되는 smoke test.
     * DuckDB 가 정상적으로 임베디드 구동되는지 검증한다.
     */
    public void smokeTest() {
        try (Statement st = statement();
             ResultSet rs = st.executeQuery("SELECT 42 AS answer, version() AS version")) {
            if (rs.next()) {
                int answer = rs.getInt("answer");
                String version = rs.getString("version");
                log.info("DuckDB smoke test OK — answer={}, version={}", answer, version);
            }
        } catch (SQLException e) {
            log.error("DuckDB smoke test FAILED", e);
            throw new RuntimeException("DuckDB initialization failed", e);
        }
    }

    @PreDestroy
    public void close() {
        if (connection != null) {
            try {
                connection.close();
                log.info("DuckDB connection closed");
            } catch (SQLException e) {
                log.warn("Failed to close DuckDB connection", e);
            }
        }
    }
}

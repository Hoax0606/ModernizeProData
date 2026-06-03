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
                // encodings 확장 — Shift-JIS/EUC-JP 등 비 UTF-8 CSV 적재용 (ExtractStage encoding=).
                loadEncodingsExtension(connection);
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
     * DuckDB encodings 확장 로드 — read_csv 의 encoding='shift_jis' 등을 가능하게 함.
     * UTF-8/UTF-16/Latin-1 은 native 라 확장 없이도 동작하므로, 로드 실패해도 DuckDB 자체는 막지 않는다.
     * 폐쇄망에서는 install 단계 의 인터넷 다운로드 불가 → 인스톨러 동봉 binary 의 LOAD '<full-path>'.
     */
    private void loadEncodingsExtension(Connection conn) {
        loadBundledOrRemote(conn, "encodings", "비 UTF-8 CSV 적재 불가");
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
        return getConnection().createStatement();
    }

    /**
     * 같은 DuckDB 인스턴스를 공유하는 별도 connection. 병렬 작업(Load 병렬 적재)에서
     * 단일 공유 connection 동시 사용을 피하기 위해 thread 마다 하나씩 쓰고 닫는다.
     * DuckDBConnection.duplicate() 는 같은 in-memory/file db 를 바라보는 새 connection.
     * caller 가 close() 책임. (UDF 는 미등록 — Load 의 read-only COPY 엔 불필요.)
     */
    public Connection duplicateConnection() throws SQLException {
        long t0 = perfEnabled ? System.nanoTime() : 0L;
        final Connection dup;
        synchronized (this) {
            long t1 = perfEnabled ? System.nanoTime() : 0L;
            dup = ((org.duckdb.DuckDBConnection) getConnection()).duplicate();
            if (perfEnabled) {
                long t2 = System.nanoTime();
                long waitMs = (t1 - t0) / 1_000_000;
                long holdMs = (t2 - t1) / 1_000_000;
                if (waitMs > 5 || holdMs > 100) {
                    log.info("[perf] duckdb.duplicate waitMs={} holdMs={}", waitMs, holdMs);
                }
            }
        }
        return dup;
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

package com.ksinfo.modernize_pro_data.common.duckdb;

import com.ksinfo.modernize_pro_data.common.duckdb.udf.UdfRegistry;
import jakarta.annotation.PreDestroy;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;

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

    private Connection connection;

    public synchronized Connection getConnection() throws SQLException {
        if (connection == null || connection.isClosed()) {
            String url = memoryMode ? "jdbc:duckdb:" : "jdbc:duckdb:" + filePath;
            connection = DriverManager.getConnection(url);
            log.info("DuckDB connection opened: {}", url);
            // DuckDB 의 UDF 는 connection 별로 등록 — 새 connection 마다 일괄 register.
            UdfRegistry.registerAll(connection);
            // encodings 확장 — Shift-JIS/EUC-JP 등 비 UTF-8 CSV 적재용 (ExtractStage encoding=).
            loadEncodingsExtension(connection);
        }
        return connection;
    }

    /**
     * DuckDB encodings 확장 로드 — read_csv 의 encoding='shift_jis' 등을 가능하게 함.
     * UTF-8/UTF-16/Latin-1 은 native 라 확장 없이도 동작하므로, 로드 실패해도 DuckDB 자체는 막지 않는다.
     * 폐쇄망(air-gapped)에서는 INSTALL 이 인터넷 다운로드를 못 하므로, 인스톨러에 확장 바이너리를
     * 동봉하고 로컬 경로 INSTALL 로 교체해야 한다 (패키징 후속 작업).
     */
    private void loadEncodingsExtension(Connection conn) {
        try (Statement st = conn.createStatement()) {
            st.execute("INSTALL encodings");
            st.execute("LOAD encodings");
            log.info("DuckDB encodings extension loaded");
        } catch (SQLException e) {
            log.warn("DuckDB encodings extension 로드 실패 — 비 UTF-8 CSV 적재 불가 "
                    + "(폐쇄망이면 확장 바이너리 동봉 필요): {}", e.getMessage());
        }
    }

    public Statement statement() throws SQLException {
        return getConnection().createStatement();
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

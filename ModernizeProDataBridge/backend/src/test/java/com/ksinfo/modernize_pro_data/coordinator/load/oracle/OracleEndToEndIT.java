package com.ksinfo.modernize_pro_data.coordinator.load.oracle;

import com.ksinfo.modernize_pro_data.coordinator.ddl.DdlColumn;
import com.ksinfo.modernize_pro_data.coordinator.load.DuckDbSqlDialect;
import com.ksinfo.modernize_pro_data.coordinator.load.spi.LoadRequest;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.oracle.OracleContainer;
import org.testcontainers.utility.DockerImageName;

import java.math.BigDecimal;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.Statement;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Oracle 적재 E2E — <b>JDBC batch INSERT</b> 실경로. DuckDB(UTF-8) ResultSet → {@link OracleLoaderAdapter#load}
 * → ojdbc 가 Oracle NLS 로 변환 저장 (중간 파일·sqlldr·Instant Client 없음).
 *
 * <p>검증: (1) 일본어 라운드트립(あ/髙/東京都), (2) 소수 {@code BALANCE NUMERIC(15,2)} 값 라운드트립,
 * (3) <b>R1 checksum 패리티</b> — DuckDB(UTF-8 SHA-256) == Oracle({@code STANDARD_HASH(UTF-8)});
 * BALANCE(scale 2)가 포함돼 {@code canonicalNumber}(trailing-zero) 버그 재발을 잡는다.
 *
 * <p>Docker + gvenzl/oracle-free(faststart=AL32UTF8) 필요. SJIS-특정 fail-fast 는 단위 테스트
 * {@code TargetCharsetValidatorTest} 가 담당.
 */
@Testcontainers
class OracleEndToEndIT {

    @Container
    static final OracleContainer ORACLE = new OracleContainer(
            DockerImageName.parse("gvenzl/oracle-free:23-slim-faststart"))
            .withUsername("app")
            .withPassword("app_pw");

    private Map<String, Object> dbConfig() {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("type", "oracle");
        m.put("host", ORACLE.getHost());
        m.put("port", ORACLE.getOraclePort());
        m.put("database", ORACLE.getDatabaseName());
        m.put("username", ORACLE.getUsername());
        m.put("password", ORACLE.getPassword());
        return m;
    }

    private static DdlColumn col(int ord, String name, String type, Integer len, Integer prec,
                                 boolean nullable, Integer pk) {
        DdlColumn c = DdlColumn.create("t", ord, name, type, type);
        c.setLength(len);
        c.setPrecision(prec);
        c.setNullable(nullable);
        c.setPkOrder(pk);
        return c;
    }

    @Test
    void jdbcBatchRoundTripAndChecksumParity(@TempDir Path work) throws Exception {
        DdlColumn balanceCol = col(2, "BALANCE", "NUMERIC", null, 15, true, null);
        balanceCol.setScale(2);   // NUMERIC(15,2) — scale 있는 숫자. canonicalNumber 버그 재발 방지.
        List<DdlColumn> meta = List.of(
                col(0, "ID", "NUMBER", null, 10, false, 1),
                col(1, "NAME", "VARCHAR2", 100, null, true, null),
                balanceCol);
        List<String> columns = List.of("ID", "NAME", "BALANCE");

        OracleLoaderAdapter adapter = new OracleLoaderAdapter();
        Map<String, Object> dbConfig = dbConfig();

        try (Connection ora = adapter.openConnection(dbConfig, false)) {
            // 1) Oracle 테이블 생성 (OracleDdlGenerator 멱등 PL/SQL).
            try (Statement st = ora.createStatement()) {
                st.execute(OracleDdlGenerator.createTableIfNotExists("", "CUST", meta, "JA16SJIS"));
            }

            // 2) DuckDB 소스 준비 + adapter.load()(JDBC batch, ojdbc 가 charset 변환).
            try (Connection duck = DriverManager.getConnection("jdbc:duckdb:")) {
                try (Statement st = duck.createStatement()) {
                    st.execute("CREATE TABLE \"tobe_cust\" (\"ID\" INTEGER, \"NAME\" VARCHAR, \"BALANCE\" DECIMAL(15,2))");
                    st.execute("INSERT INTO \"tobe_cust\" VALUES (1, 'あ', 1000.50), (2, '髙', 2500.00), (3, '東京都', 0.00)");
                }
                long loaded;
                try (Statement st = duck.createStatement();
                     ResultSet rs = st.executeQuery("SELECT \"ID\", \"NAME\", \"BALANCE\" FROM \"tobe_cust\" ORDER BY \"ID\"")) {
                    LoadRequest req = new LoadRequest(dbConfig, ora, "", "CUST", "\"CUST\"",
                            columns, rs, "JA16SJIS", work, () -> false, meta);
                    loaded = adapter.load(req);
                }
                assertEquals(3, loaded, "JDBC batch 로 3 행 적재");

                // 3) 라운드트립: 일본어 + 소수 balance.
                Map<Integer, String> got = new LinkedHashMap<>();
                Map<Integer, BigDecimal> bal = new LinkedHashMap<>();
                try (Statement st = ora.createStatement();
                     ResultSet rs = st.executeQuery("SELECT \"ID\", \"NAME\", \"BALANCE\" FROM \"CUST\" ORDER BY \"ID\"")) {
                    while (rs.next()) { got.put(rs.getInt(1), rs.getString(2)); bal.put(rs.getInt(1), rs.getBigDecimal(3)); }
                }
                assertEquals(Map.of(1, "あ", 2, "髙", 3, "東京都"), got, "일본어가 손상 없이 저장·복원돼야 함");
                assertEquals(0, bal.get(1).compareTo(new BigDecimal("1000.50")), "balance 1000.50 값 일치");
                assertEquals(0, bal.get(3).compareTo(new BigDecimal("0.00")), "balance 0.00 값 일치");

                // 4) R1 checksum 패리티 — DuckDB(UTF-8) == Oracle(STANDARD_HASH of UTF-8). BALANCE 소수 포함.
                var duckD = DuckDbSqlDialect.INSTANCE;
                var oraD = OracleSqlDialect.INSTANCE;
                List<String> duckExprs = List.of(
                        "COALESCE(" + duckD.canonicalNumber("ID", null) + ", '')",
                        "COALESCE(" + duckD.textExpr(duckD.quoteIdent("NAME")) + ", '')",
                        "COALESCE(" + duckD.canonicalNumber("BALANCE", 2) + ", '')");
                List<String> oraExprs = List.of(
                        "COALESCE(" + oraD.canonicalNumber("ID", null) + ", '')",
                        "COALESCE(" + oraD.textExpr(oraD.quoteIdent("NAME")) + ", '')",
                        "COALESCE(" + oraD.canonicalNumber("BALANCE", 2) + ", '')");

                String duckHash = scalar(duck, duckD.checksumQuery("\"tobe_cust\"", duckExprs));
                String oraHash = scalar(ora, oraD.checksumQuery("\"CUST\"", oraExprs));
                assertNotNull(duckHash);
                assertTrue(duckHash.matches("[0-9a-f]{64}"), "DuckDB SHA-256 hex: " + duckHash);
                assertEquals(duckHash, oraHash,
                        "R1: DuckDB(UTF-8) 와 Oracle(UTF-8 STANDARD_HASH) checksum 이 일치해야 함");
            }
        }
    }

    private static String scalar(Connection c, String sql) throws Exception {
        try (Statement st = c.createStatement(); ResultSet rs = st.executeQuery(sql)) {
            rs.next();
            return rs.getString(1);
        }
    }
}

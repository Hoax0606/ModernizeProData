package com.ksinfo.modernize_pro_data.coordinator.load;

import org.junit.jupiter.api.Test;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

import java.math.BigDecimal;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.ResultSetMetaData;
import java.sql.Statement;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;

/**
 * CDC 델타 병합 E2E — {@link PgCopyManager#mergeFromResultSet} 실경로.
 * DuckDB tobe_(op-type 포함) ResultSet → PG 타깃에 PK 기준 upsert(I/U)+delete(D) 병합.
 *
 * <p>검증: (a) I/U/D 각각 반영 + 미변경 행 불변, (b) 멱등(같은 델타 재적용 무해),
 * (c) PK 없으면 fail-fast, (d) op-type 제어 컬럼(__op)이 타깃 본테이블에 새지 않음.
 * H2 금지 — Testcontainers PostgreSQL(운영 PG18 계열).
 */
@Testcontainers
class PgDeltaMergeIT {

    @Container
    static final PostgreSQLContainer<?> PG = new PostgreSQLContainer<>("postgres:18-alpine");

    private final PgCopyManager pg = new PgCopyManager();

    private static final List<String> COLS =
            List.of("account_id", "owner", "balance", "status", "__op");

    private Connection target() throws Exception {
        return DriverManager.getConnection(PG.getJdbcUrl(), PG.getUsername(), PG.getPassword());
    }

    /** 초기 전량적재를 흉내 — 타깃 테이블 + PK + 기존 3행. */
    private void initialLoad(Connection c) throws Exception {
        try (Statement st = c.createStatement()) {
            st.execute("DROP TABLE IF EXISTS accounts");
            st.execute("CREATE TABLE accounts ("
                    + "account_id int PRIMARY KEY, owner varchar(100), "
                    + "balance numeric(15,2), status varchar(10))");
            st.execute("INSERT INTO accounts VALUES "
                    + "(1,'A',100.00,'ACTIVE'),(2,'B',200.00,'INACTIVE'),(3,'C',300.00,'ACTIVE')");
        }
    }

    /** DuckDB 델타 소스: id1=UPDATE, id4=INSERT, id2=DELETE (id3 미변경). */
    private void seedDelta(Connection duck) throws Exception {
        try (Statement st = duck.createStatement()) {
            st.execute("CREATE OR REPLACE TABLE \"tobe_accounts\" ("
                    + "\"account_id\" INTEGER, \"owner\" VARCHAR, \"balance\" DECIMAL(15,2), "
                    + "\"status\" VARCHAR, \"__op\" VARCHAR)");
            st.execute("INSERT INTO \"tobe_accounts\" VALUES "
                    + "(1,'A2',150.00,'ACTIVE','U'),"
                    + "(4,'D',400.00,'ACTIVE','I'),"
                    + "(2,NULL,NULL,NULL,'D')");
        }
    }

    private long merge(Connection tgt, Connection duck, List<String> pk) throws Exception {
        try (Statement st = duck.createStatement();
             ResultSet rs = st.executeQuery(
                     "SELECT \"account_id\",\"owner\",\"balance\",\"status\",\"__op\" FROM \"tobe_accounts\"")) {
            return pg.mergeFromResultSet(tgt, "accounts", COLS, "__op", pk, rs, () -> false);
        }
    }

    private Map<Integer, String> owners(Connection c) throws Exception {
        Map<Integer, String> m = new LinkedHashMap<>();
        try (Statement st = c.createStatement();
             ResultSet rs = st.executeQuery("SELECT account_id, owner FROM accounts ORDER BY account_id")) {
            while (rs.next()) m.put(rs.getInt(1), rs.getString(2));
        }
        return m;
    }

    @Test
    void mergeAppliesInsertUpdateDelete() throws Exception {
        try (Connection tgt = target(); Connection duck = DriverManager.getConnection("jdbc:duckdb:")) {
            initialLoad(tgt);
            seedDelta(duck);

            long n = merge(tgt, duck, List.of("account_id"));
            assertEquals(3, n, "델타 3행이 staging 으로 들어와야");

            // 최종: id2 삭제, id1 갱신, id4 삽입, id3 불변.
            assertEquals(Map.of(1, "A2", 3, "C", 4, "D"), owners(tgt));

            // 값(숫자/텍스트) 반영 확인.
            try (Statement st = tgt.createStatement();
                 ResultSet rs = st.executeQuery("SELECT balance, status FROM accounts WHERE account_id=1")) {
                rs.next();
                assertEquals(0, rs.getBigDecimal(1).compareTo(new BigDecimal("150.00")), "id1 balance 갱신");
                assertEquals("ACTIVE", rs.getString(2));
            }
        }
    }

    @Test
    void mergeIsIdempotent() throws Exception {
        try (Connection tgt = target(); Connection duck = DriverManager.getConnection("jdbc:duckdb:")) {
            initialLoad(tgt);
            seedDelta(duck);
            merge(tgt, duck, List.of("account_id"));
            Map<Integer, String> after1 = owners(tgt);
            // 같은 델타 재적용 — upsert 멱등 + 이미 지운 행 delete no-op → 결과 동일.
            merge(tgt, duck, List.of("account_id"));
            assertEquals(after1, owners(tgt), "같은 델타 재적용은 상태를 바꾸지 않아야(멱등)");
        }
    }

    @Test
    void mergeRequiresPrimaryKey() throws Exception {
        try (Connection tgt = target(); Connection duck = DriverManager.getConnection("jdbc:duckdb:")) {
            initialLoad(tgt);
            seedDelta(duck);
            assertThrows(IllegalStateException.class,
                    () -> merge(tgt, duck, List.of()), "PK 없으면 병합 불가(fail-fast)");
        }
    }

    @Test
    void opColumnDoesNotLeakIntoTarget() throws Exception {
        try (Connection tgt = target(); Connection duck = DriverManager.getConnection("jdbc:duckdb:")) {
            initialLoad(tgt);
            seedDelta(duck);
            merge(tgt, duck, List.of("account_id"));
            try (Statement st = tgt.createStatement();
                 ResultSet rs = st.executeQuery("SELECT * FROM accounts LIMIT 0")) {
                ResultSetMetaData md = rs.getMetaData();
                boolean hasOp = false;
                for (int i = 1; i <= md.getColumnCount(); i++) {
                    if ("__op".equalsIgnoreCase(md.getColumnLabel(i))) hasOp = true;
                }
                assertFalse(hasOp, "제어 컬럼 __op 이 타깃 본테이블에 새면 안 됨");
            }
        }
    }
}

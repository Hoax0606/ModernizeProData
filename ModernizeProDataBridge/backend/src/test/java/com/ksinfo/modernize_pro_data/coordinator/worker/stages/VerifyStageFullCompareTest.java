package com.ksinfo.modernize_pro_data.coordinator.worker.stages;

import com.ksinfo.modernize_pro_data.TestcontainersConfiguration;
import com.ksinfo.modernize_pro_data.common.duckdb.DuckDbService;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.testcontainers.containers.PostgreSQLContainer;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.Statement;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * VerifyStage 의 PK 전수 비교({@link VerifyStage#compareAllPkRows}) 동작 검증.
 *
 * 핵심 회귀: 예전 구현은 양쪽 첫 100 행만 비교(LIMIT 100)했기 때문에
 * 101 행째 이후의 PK 불일치를 놓쳤다. 이제는 전수 비교라 그 너머도 잡아야 한다.
 *
 * 그래서 이 테스트는 **150 행 중 130 행째(>100)에 PK 불일치를 심고**, 새 구현이
 * 그것을 잡아내는지(non-null + "row 130")를 확인한다. 옛 100-limit 구현이라면
 * 이 케이스는 통과(null)로 새어나갔을 것이므로, 이 한 케이스가 수정의 증거다.
 *
 * 실제 DuckDB(in-memory) 와 일회용 PostgreSQL(Testcontainers) 를 그대로 써서
 * VerifyStage 가 production 에서 도는 경로와 동일하게 검증한다. (H2 금지 정책 준수.)
 */
@SpringBootTest
@Import(TestcontainersConfiguration.class)
class VerifyStageFullCompareTest {

    private static final String DUCK_SCHEMA = "run_verify_test";
    private static final String DUCK_FQ = "\"" + DUCK_SCHEMA + "\".\"tobe_verify_target\"";
    private static final String PG_FQ = "\"public\".\"verify_target\"";
    private static final int ROW_COUNT = 150;        // > 100 (옛 SAMPLE_LIMIT)
    private static final int MISMATCH_AT = 130;      // 불일치를 심을 행 (>100)

    @Autowired
    private VerifyStage verifyStage;

    @Autowired
    private DuckDbService duckDbService;

    @Autowired
    private PostgreSQLContainer<?> postgres;

    private Map<String, Object> dbConfig() {
        return Map.of(
                "host", postgres.getHost(),
                "port", postgres.getMappedPort(5432),
                "database", postgres.getDatabaseName(),
                "username", postgres.getUsername(),
                "password", postgres.getPassword());
    }

    /** PG 쪽 TO-BE 테이블: id 1..ROW_COUNT (적재 결과 역할). */
    private void seedPostgres() throws Exception {
        try (Connection c = DriverManager.getConnection(
                postgres.getJdbcUrl(), postgres.getUsername(), postgres.getPassword());
             Statement st = c.createStatement()) {
            st.execute("DROP TABLE IF EXISTS public.verify_target");
            st.execute("CREATE TABLE public.verify_target (id INTEGER PRIMARY KEY)");
            try (PreparedStatement ps = c.prepareStatement(
                    "INSERT INTO public.verify_target(id) VALUES (?)")) {
                for (int i = 1; i <= ROW_COUNT; i++) {
                    ps.setInt(1, i);
                    ps.addBatch();
                }
                ps.executeBatch();
            }
        }
    }

    /**
     * DuckDB 쪽 tobe_ 테이블(Transform 결과 역할): id 1..ROW_COUNT.
     * withMismatch 면 MISMATCH_AT 행의 id 를 큰 값으로 바꿔 PK 를 어긋나게 한다.
     * (row_count 는 그대로 ROW_COUNT 라서 VerifyStage 의 count-비교는 통과 → PK 비교 단계로 진입.)
     */
    private void seedDuckDb(boolean withMismatch) throws Exception {
        try (Statement st = duckDbService.statement()) {
            st.execute("DROP SCHEMA IF EXISTS \"" + DUCK_SCHEMA + "\" CASCADE");
            st.execute("CREATE SCHEMA \"" + DUCK_SCHEMA + "\"");
            st.execute("CREATE TABLE " + DUCK_FQ + " (id INTEGER)");
            st.execute("INSERT INTO " + DUCK_FQ
                    + " SELECT i::INTEGER FROM range(1, " + (ROW_COUNT + 1) + ") t(i)");
            if (withMismatch) {
                st.execute("UPDATE " + DUCK_FQ + " SET id = 999999 WHERE id = " + MISMATCH_AT);
            }
        }
    }

    @Test
    void catchesPkMismatchBeyondRow100() throws Exception {
        seedPostgres();
        seedDuckDb(true);

        String result = verifyStage.compareAllPkRows(DUCK_FQ, PG_FQ, List.of("id"), dbConfig());

        // 전수 비교라야만 잡히는 불일치 — 옛 100-limit 이면 null 로 새어나갔을 케이스.
        assertNotNull(result, "130번째 행의 PK 불일치를 전수 비교가 잡아야 한다");
        assertTrue(result.contains("row " + MISMATCH_AT),
                "불일치 위치가 " + MISMATCH_AT + " 행으로 보고돼야 한다. actual=" + result);
    }

    @Test
    void identicalRowsPass() throws Exception {
        seedPostgres();
        seedDuckDb(false);

        String result = verifyStage.compareAllPkRows(DUCK_FQ, PG_FQ, List.of("id"), dbConfig());

        assertNull(result, "150 행 전부 일치하면 전수 비교 결과는 null(통과) 이어야 한다");
    }
}

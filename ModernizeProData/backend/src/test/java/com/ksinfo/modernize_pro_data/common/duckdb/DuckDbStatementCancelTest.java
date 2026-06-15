package com.ksinfo.modernize_pro_data.common.duckdb;

import org.junit.jupiter.api.Test;

import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * B (mid-query abort) 의 핵심 가정 검증: 다른 thread 에서 {@link Statement#cancel()} 을 호출하면
 * DuckDB(JDBC 1.5.3.0)가 <b>실행 중인 긴 쿼리를 즉시 interrupt</b> 하는가.
 *
 * <p>RunControlRegistry.cancel 이 stage 실행 thread 와 다른 thread(abort/timeout)에서 동작하므로
 * cross-thread cancel 이 실제로 먹히는지가 관건. 설치본 = file-mode 라
 * ([[duckdb-run-isolation]]) <b>file-mode connection 으로도</b> 검증한다.
 */
class DuckDbStatementCancelTest {

    /** generate_series 로 충분히 긴 집계 — cancel 안 하면 수 초 이상 걸리도록. */
    private static final String LONG_QUERY =
            "SELECT count(*) FROM (SELECT * FROM range(20000000000)) t";

    @Test
    void cancelInterruptsLongQuery_memoryMode() throws Exception {
        try (Connection conn = DriverManager.getConnection("jdbc:duckdb:")) {
            assertInterrupted(conn);
        }
    }

    @Test
    void cancelInterruptsLongQuery_fileMode() throws Exception {
        Path dir = Files.createTempDirectory("duck-cancel-test");
        Path dbFile = dir.resolve("run.duckdb");
        try (Connection conn = DriverManager.getConnection("jdbc:duckdb:" + dbFile)) {
            assertInterrupted(conn);
        } finally {
            // best-effort cleanup
            try { Files.deleteIfExists(dbFile); } catch (Exception ignore) {}
            try { Files.deleteIfExists(dir); } catch (Exception ignore) {}
        }
    }

    private void assertInterrupted(Connection conn) throws Exception {
        Statement st = conn.createStatement();
        CountDownLatch started = new CountDownLatch(1);
        AtomicReference<Throwable> thrown = new AtomicReference<>();
        CountDownLatch done = new CountDownLatch(1);

        Thread queryThread = new Thread(() -> {
            try {
                started.countDown();
                st.execute(LONG_QUERY);   // cancel 안 되면 매우 오래 block
            } catch (Throwable t) {
                thrown.set(t);
            } finally {
                done.countDown();
            }
        }, "duck-long-query");
        queryThread.setDaemon(true);
        queryThread.start();

        // 쿼리가 실제로 시작될 시간을 약간 준 뒤 다른 thread 에서 cancel.
        assertTrue(started.await(2, TimeUnit.SECONDS), "query thread 시작 안 됨");
        Thread.sleep(400);
        st.cancel();

        // cancel 이 먹으면 쿼리는 수 초 내 예외로 끝나야 함. (안 먹으면 10s 안에 안 끝남)
        boolean finished = done.await(10, TimeUnit.SECONDS);
        assertTrue(finished, "cancel() 후에도 쿼리가 10초 내 종료 안 됨 — interrupt 미동작 가능성");

        Throwable t = thrown.get();
        assertNotNull(t, "cancel 했는데 쿼리가 예외 없이 정상 완료됨 — interrupt 안 됨");
        // DuckDB 는 interrupt 시 SQLException("INTERRUPT"/"cancel" 류) 을 던진다.
        assertTrue(t instanceof SQLException, "예상치 못한 예외 타입: " + t);
        System.out.println("[duck-cancel] interrupted as expected: " + t.getMessage());

        try { st.close(); } catch (SQLException ignore) {}
    }
}

package com.ksinfo.modernize_pro_data.common.duckdb.udf;

import org.duckdb.DuckDBFunctions;

import java.sql.Connection;
import java.sql.SQLException;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.Function;

/**
 * assign_seq(VARCHAR partition_key) → BIGINT
 *
 * partition 별 독립 시퀀스. 동일 입력에 대해 호출마다 다른 값을 반환한다.
 * {@code withVolatile()} 없으면 DuckDB 가 같은 입력에 캐싱하여 모든 행이 같은
 * 번호를 받는 버그가 생긴다 (Notion §3-1).
 *
 *   assign_seq("DEPT_A")  → 1, 2, 3, ...   (호출마다 +1)
 *   assign_seq("DEPT_B")  → 1, 2, 3, ...   (독립 카운터)
 *   assign_seq(null)      → 전역 카운터 사용 (__global__)
 *
 * 카운터는 프로세스 메모리에 보관 — 재기동 시 1 부터 다시 시작.
 * Production 에서는 메타DB 의 시퀀스 테이블로 옮겨야 (별도 task).
 */
public final class AssignSeqUdf {

    private AssignSeqUdf() {}

    private static final ConcurrentHashMap<String, AtomicLong> COUNTERS = new ConcurrentHashMap<>();

    public static void register(Connection conn) throws SQLException {
        DuckDBFunctions.scalarFunction()
                .withName("assign_seq")
                .withParameter(String.class)
                .withReturnType(Long.class)
                .withFunction((Function<String, Long>) AssignSeqUdf::apply)
                .withVolatile()
                .register(conn);
    }

    static Long apply(String partition) {
        String key = (partition == null) ? "__global__" : partition;
        return COUNTERS.computeIfAbsent(key, k -> new AtomicLong(0)).incrementAndGet();
    }
}

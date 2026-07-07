package com.ksinfo.modernize_pro_data.coordinator.worker.stages;

import org.junit.jupiter.api.Test;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.Statement;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * DATE 시각 silent 손실 검출 — TransformStage.checkDateTimeLoss 의 핵심:
 *   1) isDateOnly: PG date 만 검출 대상(timestamp 등 제외).
 *   2) probe SQL: 변환식 값을 TIMESTAMP 로 평가해 EXTRACT 시·분·초<>0 행을 센다.
 *      DuckDB 에서 그 패턴이 비-자정 시각 행만 정확히 세는지 검증(=PG date 적재 시 손실 예정 행).
 */
class TransformTimeLossTest {

    @Test
    void isDateOnly_onlyMatchesDate() {
        assertTrue(TransformStage.isDateOnly("date"));
        assertTrue(TransformStage.isDateOnly("DATE"));
        assertTrue(TransformStage.isDateOnly("  Date "));
        assertFalse(TransformStage.isDateOnly("timestamp"));
        assertFalse(TransformStage.isDateOnly("timestamptz"));
        assertFalse(TransformStage.isDateOnly("timestamp without time zone"));
        assertFalse(TransformStage.isDateOnly("varchar"));
        assertFalse(TransformStage.isDateOnly(null));
    }

    @Test
    void probeCountsOnlyNonMidnightRows() throws Exception {
        try (Connection conn = DriverManager.getConnection("jdbc:duckdb:");
             Statement st = conn.createStatement()) {
            st.execute("CREATE TABLE asis (txn_dttm VARCHAR)");
            // 2건은 시각 있음(손실), 1건 자정(손실 아님), 1건 날짜만(손실 아님), 1건 비-timestamp(무시).
            st.execute("INSERT INTO asis VALUES "
                    + "('2025-01-15 14:30:25'),"
                    + "('2025-01-15 09:00:01'),"
                    + "('2025-01-15 00:00:00'),"
                    + "('2025-01-15'),"
                    + "('not-a-date')");

            // checkDateTimeLoss 가 만드는 것과 동일 패턴: expr=txn_dttm, TRY_CAST AS TIMESTAMP.
            String inner = "SELECT TRY_CAST((txn_dttm) AS TIMESTAMP) AS __ts FROM asis";
            String cond = "__ts IS NOT NULL AND (EXTRACT(hour FROM __ts) <> 0"
                    + " OR EXTRACT(minute FROM __ts) <> 0 OR EXTRACT(second FROM __ts) <> 0)";
            try (ResultSet rs = st.executeQuery("SELECT COUNT(*) FROM (" + inner + ") _t WHERE " + cond)) {
                rs.next();
                assertEquals(2, rs.getLong(1),
                        "시각(시·분·초)이 있는 2건만 손실 예정으로 검출돼야 한다");
            }
        }
    }
}

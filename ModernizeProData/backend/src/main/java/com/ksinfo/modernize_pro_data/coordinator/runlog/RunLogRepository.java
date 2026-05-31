package com.ksinfo.modernize_pro_data.coordinator.runlog;

import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.dao.EmptyResultDataAccessException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Transactional;

import java.sql.Timestamp;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.regex.Pattern;

/**
 * RunLog 영속화 / 조회 — JdbcTemplate 직접.
 *
 * 파티션 정책: 한 run = 한 LIST partition.  ingest 시작 시
 * {@link #ensurePartition} 가 DDL 을 한 번 실행한다 (멱등 — 이미 있으면 NO-OP).
 *
 * 본 클래스는 비싼 인덱스/스캔 경로가 모이는 지점이므로,
 *  - 무조건 keyset paging (OFFSET 안 씀)
 *  - filter 절에 항상 run_id 가 선행 (파티션 pruning 보장)
 *  - 카운트는 메타 캐시값 우선
 * 을 지킨다.
 */
@Slf4j
@Repository
@RequiredArgsConstructor
public class RunLogRepository {

    private final JdbcTemplate jdbc;

    /** run_id 가 SQL injection / DDL identifier 로 새지 않도록 화이트리스트. */
    private static final Pattern SAFE_RUN_ID = Pattern.compile("^[A-Za-z0-9_\\-]{1,40}$");

    /* ────────────────────────────── meta ────────────────────────────── */

    public Optional<RunLogMeta> findMeta(String runId) {
        try {
            RunLogMeta m = jdbc.queryForObject(
                "SELECT run_id, project_id, started_at, ended_at, parquet_root, " +
                "       total_lines, error_count, warn_count, info_count " +
                "  FROM run_log_meta WHERE run_id = ?",
                META_MAPPER, runId);
            return Optional.ofNullable(m);
        } catch (EmptyResultDataAccessException e) {
            return Optional.empty();
        }
    }

    public void upsertMeta(String runId, String projectId, String parquetRoot) {
        jdbc.update(
            "INSERT INTO run_log_meta (run_id, project_id, parquet_root) " +
            "VALUES (?, ?, ?) " +
            "ON CONFLICT (run_id) DO UPDATE SET parquet_root = EXCLUDED.parquet_root",
            runId, projectId, parquetRoot);
    }

    public void closeRun(String runId) {
        jdbc.update("UPDATE run_log_meta SET ended_at = NOW() WHERE run_id = ? AND ended_at IS NULL", runId);
    }

    public void bumpCounters(String runId, long total, long err, long warn, long info) {
        jdbc.update(
            "UPDATE run_log_meta SET " +
            "  total_lines = total_lines + ?, " +
            "  error_count = error_count + ?, " +
            "  warn_count  = warn_count  + ?, " +
            "  info_count  = info_count  + ? " +
            "WHERE run_id = ?",
            total, err, warn, info, runId);
    }

    /* ────────────────────────── partition mgmt ──────────────────────── */

    /**
     * run_id 에 대응하는 partition 이 없으면 만든다.
     *
     * 호출자가 매 ingest 마다 부담 없이 호출할 수 있도록, 이미 있으면 IF NOT EXISTS 가
     * 즉시 끝난다. partition table 이름은 run_id 를 안전 표기로 변환.
     */
    @Transactional(propagation = org.springframework.transaction.annotation.Propagation.REQUIRES_NEW)
    public void ensurePartition(String runId) {
        if (!SAFE_RUN_ID.matcher(runId).matches()) {
            throw new IllegalArgumentException("Invalid runId for partition: " + runId);
        }
        String partName = "run_log_p_" + runId.replace('-', '_').toLowerCase();
        String ddl = "CREATE TABLE IF NOT EXISTS " + partName +
                     " PARTITION OF run_log FOR VALUES IN ('" + runId + "')";
        jdbc.execute(ddl);
    }

    /* ───────────────────────────── ingest ───────────────────────────── */

    /**
     * 배치 INSERT. 진짜 12억 라인 부하 시점에는 PgCopyManager 로 교체해야 하지만,
     * MVP 단계에서는 batchUpdate 로 충분. (5만 라인/초 정도까지는 무리 없음)
     */
    public int[][] insertBatch(List<RunLogLine> lines) {
        if (lines.isEmpty()) return new int[0][];
        return jdbc.batchUpdate(
            "INSERT INTO run_log (seq, run_id, ts, level, stage, message, suggestion) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?) " +
            "ON CONFLICT (run_id, seq) DO NOTHING",
            lines,
            500,
            (ps, l) -> {
                ps.setLong(1, l.getSeq());
                ps.setString(2, l.getRunId());
                ps.setTimestamp(3, l.getTs() == null ? null
                    : Timestamp.from(l.getTs().toInstant()));
                ps.setShort(4, l.getLevel());
                ps.setString(5, l.getStage());
                ps.setString(6, l.getMessage());
                ps.setString(7, l.getSuggestion());
            });
    }

    /* ───────────────────────────── queries ──────────────────────────── */

    public record Cursor(OffsetDateTime ts, long seq) { }

    /**
     * Keyset paging. (ts DESC, seq DESC) 인덱스에 정확히 맞춤.
     * cursor 가 null 이면 최신부터. levels 가 비어있으면 모든 level.
     */
    public List<RunLogLine> queryKeyset(String runId, Cursor cursor,
                                        List<Short> levels, String q, int limit) {
        StringBuilder sql = new StringBuilder(
            "SELECT seq, run_id, ts, level, stage, message, suggestion " +
            "  FROM run_log WHERE run_id = ?");
        List<Object> args = new ArrayList<>();
        args.add(runId);

        if (cursor != null) {
            // (ts, seq) < (cursorTs, cursorSeq)  — row comparison
            sql.append(" AND (ts, seq) < (?, ?)");
            args.add(Timestamp.from(cursor.ts().toInstant()));
            args.add(cursor.seq());
        }

        if (levels != null && !levels.isEmpty()) {
            sql.append(" AND level IN (");
            for (int i = 0; i < levels.size(); i++) {
                sql.append(i == 0 ? "?" : ",?");
                args.add(levels.get(i).shortValue());
            }
            sql.append(")");
        }

        if (q != null && !q.isBlank()) {
            // MVP: ILIKE.  Phase B 에서 pg_trgm GIN 으로 전환.
            sql.append(" AND message ILIKE ?");
            args.add("%" + q + "%");
        }

        sql.append(" ORDER BY ts DESC, seq DESC LIMIT ?");
        args.add(limit);

        return jdbc.query(sql.toString(), LINE_MAPPER, args.toArray());
    }

    /** seq 기반 context — selected row 의 앞뒤 ±window. */
    public List<RunLogLine> queryAround(String runId, long seq, int window) {
        return jdbc.query(
            "SELECT seq, run_id, ts, level, stage, message, suggestion " +
            "  FROM run_log " +
            " WHERE run_id = ? AND seq BETWEEN ? AND ? " +
            " ORDER BY seq ASC",
            LINE_MAPPER, runId, seq - window, seq + window);
    }

    /** ID 정확 매칭 (selected snapshot 의 detail 호출용). */
    public Optional<RunLogLine> findOne(String runId, long seq) {
        try {
            return Optional.ofNullable(jdbc.queryForObject(
                "SELECT seq, run_id, ts, level, stage, message, suggestion " +
                "  FROM run_log WHERE run_id = ? AND seq = ?",
                LINE_MAPPER, runId, seq));
        } catch (EmptyResultDataAccessException e) {
            return Optional.empty();
        }
    }

    /* ────────────────────────── row mappers ─────────────────────────── */

    private static final RowMapper<RunLogLine> LINE_MAPPER = (rs, n) -> RunLogLine.builder()
        .seq(rs.getLong("seq"))
        .runId(rs.getString("run_id"))
        .ts(rs.getTimestamp("ts").toInstant().atOffset(ZoneOffset.UTC))
        .level(rs.getShort("level"))
        .stage(rs.getString("stage"))
        .message(rs.getString("message"))
        .suggestion(rs.getString("suggestion"))
        .build();

    private static final RowMapper<RunLogMeta> META_MAPPER = (rs, n) -> RunLogMeta.builder()
        .runId(rs.getString("run_id"))
        .projectId(rs.getString("project_id"))
        .startedAt(rs.getTimestamp("started_at") == null ? null
            : rs.getTimestamp("started_at").toInstant().atOffset(ZoneOffset.UTC))
        .endedAt(rs.getTimestamp("ended_at") == null ? null
            : rs.getTimestamp("ended_at").toInstant().atOffset(ZoneOffset.UTC))
        .parquetRoot(rs.getString("parquet_root"))
        .totalLines(rs.getLong("total_lines"))
        .errorCount(rs.getLong("error_count"))
        .warnCount(rs.getLong("warn_count"))
        .infoCount(rs.getLong("info_count"))
        .build();
}

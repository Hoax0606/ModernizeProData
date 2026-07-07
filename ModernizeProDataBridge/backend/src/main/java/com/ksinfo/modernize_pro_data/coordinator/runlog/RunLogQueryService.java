package com.ksinfo.modernize_pro_data.coordinator.runlog;

import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

import java.nio.charset.StandardCharsets;
import java.time.OffsetDateTime;
import java.util.Base64;
import java.util.List;
import java.util.Optional;

/**
 * 화면 측 조회 — keyset paging 캡슐화 + cursor 인/디코딩.
 *
 * cursor 포맷:  base64( "<isoTs>|<seq>" )
 *   - 외부로 노출되는 표면적이 작도록 인코딩만 한 번 감싼다 (서명/암호화 X — 무결성은 PK 가 보호).
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class RunLogQueryService {

    private final RunLogRepository repo;

    public Page list(String runId, String cursorOpaque, List<Short> levels, String q, int limit) {
        if (limit <= 0 || limit > 1000) limit = 500;
        RunLogRepository.Cursor cursor = decodeCursor(cursorOpaque);
        List<RunLogLine> lines = repo.queryKeyset(runId, cursor, levels, q, limit);
        String next = null;
        if (lines.size() == limit) {
            RunLogLine last = lines.get(lines.size() - 1);
            next = encodeCursor(new RunLogRepository.Cursor(last.getTs(), last.getSeq()));
        }
        return new Page(lines, next);
    }

    public List<RunLogLine> around(String runId, long seq, int window) {
        if (window <= 0 || window > 100) window = 10;
        return repo.queryAround(runId, seq, window);
    }

    public Optional<RunLogLine> findOne(String runId, long seq) {
        return repo.findOne(runId, seq);
    }

    public Counts counts(String runId) {
        return repo.findMeta(runId)
            .map(m -> new Counts(m.getInfoCount(), m.getWarnCount(), m.getErrorCount(), m.getTotalLines()))
            .orElseGet(() -> new Counts(0, 0, 0, 0));
    }

    /* ───────────────────────── cursor codec ─────────────────────────── */

    private static String encodeCursor(RunLogRepository.Cursor c) {
        String raw = c.ts().toString() + "|" + c.seq();
        return Base64.getUrlEncoder().withoutPadding()
            .encodeToString(raw.getBytes(StandardCharsets.UTF_8));
    }

    private static RunLogRepository.Cursor decodeCursor(String opaque) {
        if (opaque == null || opaque.isBlank()) return null;
        try {
            String raw = new String(Base64.getUrlDecoder().decode(opaque), StandardCharsets.UTF_8);
            int bar = raw.indexOf('|');
            if (bar <= 0) return null;
            OffsetDateTime ts = OffsetDateTime.parse(raw.substring(0, bar));
            long seq = Long.parseLong(raw.substring(bar + 1));
            return new RunLogRepository.Cursor(ts, seq);
        } catch (Exception e) {
            log.warn("Invalid log cursor; ignoring: {}", opaque);
            return null;
        }
    }

    public record Page(List<RunLogLine> lines, String nextCursor) { }
    public record Counts(long info, long warn, long error, long total) { }
}

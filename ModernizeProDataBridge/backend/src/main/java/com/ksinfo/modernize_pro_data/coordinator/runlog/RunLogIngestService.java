package com.ksinfo.modernize_pro_data.coordinator.runlog;

import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.dao.DataAccessException;
import org.springframework.messaging.simp.SimpMessagingTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.List;

/**
 * Worker → Coordinator 인제스트 진입점.
 *
 * 한 chunk 의 처리:
 *   1) partition 보장
 *   2) WARN/ERROR 는 전부, INFO 는 1% 만 (seq % 100 == 0) PG 로
 *   3) 메타 카운터 누적
 *   4) STOMP /topic/project/{projectId}/log 로 fan-out
 *
 * Phase B 에서 ALL 라인을 Parquet 으로 떨구는 단계가 여기 들어온다.
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class RunLogIngestService {

    private final RunLogRepository repo;
    private final SimpMessagingTemplate stomp;

    private static final int INFO_SAMPLE_MOD = 100;   // 1% 샘플
    /** INFO-only chunk 의 per-run 실시간 broadcast 최소 간격(ms) — 다중 run 시 WS flood 억제. */
    private static final long INFO_BROADCAST_THROTTLE_MS = 500;
    /** runId -> 마지막 INFO broadcast 시각(ms). WARN/ERROR 는 throttle 무시(항상 전송). */
    private final java.util.Map<String, Long> lastInfoBroadcastMs = new java.util.concurrent.ConcurrentHashMap<>();

    @Transactional
    public void openRun(String runId, String projectId) {
        repo.upsertMeta(runId, projectId, null);
        ensurePartitionBestEffort(runId);
    }

    @Transactional
    public IngestResult ingest(String runId, String projectId, List<RunLogLine> chunk) {
        if (chunk == null || chunk.isEmpty()) {
            return new IngestResult(0, 0, 0, 0);
        }

        // 첫 호출일 수도 있으니 멱등하게.
        repo.upsertMeta(runId, projectId, null);
        ensurePartitionBestEffort(runId);

        long total = 0, err = 0, warn = 0, info = 0;
        List<RunLogLine> toPersist = new ArrayList<>(chunk.size());
        OffsetDateTime nowFallback = OffsetDateTime.now();

        for (RunLogLine l : chunk) {
            l.setRunId(runId);
            if (l.getTs() == null) l.setTs(nowFallback);
            total++;
            switch (l.getLevel()) {
                case RunLogLine.LEVEL_ERROR -> { err++;  toPersist.add(l); }
                case RunLogLine.LEVEL_WARN  -> { warn++; toPersist.add(l); }
                default -> {
                    info++;
                    if (l.getSeq() % INFO_SAMPLE_MOD == 0) toPersist.add(l);
                }
            }
        }

        repo.insertBatch(toPersist);
        repo.bumpCounters(runId, total, err, warn, info);

        // 실시간 fan-out (2026-06-10 OOM 완화):
        //  - raw chunk(INFO 전부) 대신 **이미 필터된 toPersist**(WARN/ERROR 전부 + INFO 1%)만 전송.
        //    DB 진실원도 toPersist 라 live tail 과 저장 로그가 일치. 15+ run 동시 시 WS/heap 폭증 방지.
        //  - INFO 만 있는 chunk 는 per-run throttle(500ms) — 다중 run flood 추가 억제. WARN/ERROR 가
        //    하나라도 있으면 throttle 무시하고 즉시 전송(중요 신호 누락 X). 빈 payload 는 skip.
        if (!toPersist.isEmpty()) {
            boolean hasImportant = (err + warn) > 0;
            boolean send = hasImportant;
            if (!send) {
                long now = System.currentTimeMillis();
                Long last = lastInfoBroadcastMs.get(runId);
                if (last == null || now - last >= INFO_BROADCAST_THROTTLE_MS) {
                    lastInfoBroadcastMs.put(runId, now);
                    send = true;
                }
            }
            if (send) {
                stomp.convertAndSend("/topic/project/" + projectId + "/log",
                    new ChunkMessage(runId, projectId, toPersist));
            }
        }

        return new IngestResult(total, err, warn, info);
    }

    @Transactional
    public void closeRun(String runId) {
        repo.closeRun(runId);
        lastInfoBroadcastMs.remove(runId);   // throttle map leak 방지.
    }

    public record IngestResult(long total, long err, long warn, long info) { }

    /** STOMP 페이로드 — chunk 단위 묶음. */
    public record ChunkMessage(String runId, String projectId, List<RunLogLine> lines) { }

    /**
     * Partition 생성은 Coordinator (run_log table 의 owner) 만 가능. Worker mode 의
     * delegate 된 user 는 public schema 의 CREATE 권한이 없어 permission denied — 그
     * 경우 silent ignore. partition 자체는 Coordinator side 의 RunService.startRun 이
     * 미리 만들어 두는 게 정공이지만 (멱등), 누락 시 Coordinator 의 첫 ingest 호출이
     * 만들어 주므로 safe.
     */
    private void ensurePartitionBestEffort(String runId) {
        try {
            repo.ensurePartition(runId);
        } catch (DataAccessException e) {
            log.debug("ensurePartition skipped (likely Worker user without CREATE on public): {}",
                    e.getMessage());
        }
    }
}

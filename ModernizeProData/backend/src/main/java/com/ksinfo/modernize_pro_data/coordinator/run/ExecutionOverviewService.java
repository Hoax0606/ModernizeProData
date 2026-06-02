package com.ksinfo.modernize_pro_data.coordinator.run;

import com.ksinfo.modernize_pro_data.coordinator.quarantine.QuarantineAckService;
import com.ksinfo.modernize_pro_data.coordinator.quarantine.QuarantineEntry;
import com.ksinfo.modernize_pro_data.coordinator.quarantine.QuarantineEntryRepository;
import com.ksinfo.modernize_pro_data.coordinator.quarantine.QuarantineSeverity;
import com.ksinfo.modernize_pro_data.coordinator.run.stage.StageInstance;
import com.ksinfo.modernize_pro_data.coordinator.run.stage.StageInstanceRepository;
import com.ksinfo.modernize_pro_data.coordinator.run.stage.StageStatus;
import com.ksinfo.modernize_pro_data.coordinator.run.stage.StageTableResult;
import com.ksinfo.modernize_pro_data.coordinator.run.stage.StageTableResultRepository;
import com.ksinfo.modernize_pro_data.coordinator.run.stage.StageTableStatus;
import com.ksinfo.modernize_pro_data.coordinator.site.Project;
import com.ksinfo.modernize_pro_data.coordinator.site.ProjectRepository;
import com.ksinfo.modernize_pro_data.coordinator.site.Snapshot;
import com.ksinfo.modernize_pro_data.coordinator.site.SnapshotRepository;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;

import java.util.List;
import java.util.Optional;

/**
 * Execution overview (All projects 화면, /site/execution) 의 per-project 실행 지표 집계.
 * 각 project 의 최신 run 기준: 상태 · 적재 rows · tablesDone · error/warning · progress.
 */
@Service
@RequiredArgsConstructor
public class ExecutionOverviewService {

    private final ProjectRepository projectRepo;
    private final RunHistoryRepository runHistoryRepo;
    private final StageInstanceRepository stageInstanceRepo;
    private final StageTableResultRepository stageTableResultRepo;
    private final QuarantineEntryRepository quarantineRepo;
    private final QuarantineAckService ackService;
    private final SnapshotRepository snapshotRepo;

    /**
     * Per-row pipeline 7-bar 描画用の stage 集約.
     * FE 側 (api/runs.ts:StageView と互換) で {@code buildStagesFromStageViews} に渡せる
     * 形にしておき、ExecutionPage の per-stage chip と同じレンダラを通せる.
     * tables の詳細 (per-binding 結果) は overview では不要なので省略.
     */
    public record StageSummary(
            String stageKey,
            int seq,
            String status,       // StageStatus.name() — pending / running / success / failed
            int pct,             // 0..100. tablesSuccess / tablesTotal で BE 算出
            int tablesTotal,
            int tablesSuccess,
            int tablesFailed
    ) {}

    public record ProjectExecMetrics(
            String projectId,
            String projectName,
            String latestRunId,
            String runStatus,       // RunStatus.name() or null (run 이력 없음)
            long rows,
            int tablesTotal,
            int tablesDone,
            long errorCount,
            long warningCount,
            /** 운영자가 명시 ack 한 WARN entry 수 — KPI/그리드 의 "M/N 처리" 분수 표시용. */
            long warningAckedCount,
            int progressPct,
            /**
             * 7-stage の現在状態. run 履歴が無ければ空 List.
             * FE はこれをそのまま buildStagesFromStageViews に渡し、Execution 画面と
             * 同じレンダリングで bar を描く (旧仕様の progressPct → floor() 換算による
             * 「3 success なのに 2 bar しか塗られない」ずれを排除).
             */
            List<StageSummary> stages
    ) {}

    public List<ProjectExecMetrics> bySite(String siteId) {
        return projectRepo.findBySiteId(siteId).stream()
                .map(this::metricsFor)
                .toList();
    }

    private ProjectExecMetrics metricsFor(Project p) {
        /* Pin 中心: baseline (pinned) snapshot で起動された最新 run を優先 — running 含む.
         * pin がない or pin の snapshot で 1 度も run していない場合は project 全体の最新 run fallback.
         * これで Execution 画面 (activeRunId = pin.executionContext.runId 初期値) と
         * Overview の data 源が同じ run を見るようになり, 両画面の bar 表示が一致する.
         * (2026-05-31) */
        Optional<Snapshot> baseline = snapshotRepo.findByProjectIdAndBaselineTrue(p.getId());
        RunHistory latest = baseline
                .map(b -> runHistoryRepo.findFirstByProjectIdAndSnapshotIdOrderByStartedAtDesc(p.getId(), b.getId()))
                .orElse(null);
        if (latest == null) {
            latest = runHistoryRepo.findFirstByProjectIdOrderByStartedAtDesc(p.getId());
        }
        if (latest == null) {
            return new ProjectExecMetrics(p.getId(), p.getName(), null, null,
                    0, p.getTobeTableCount(), 0, 0, 0, 0, 0, List.of());
        }
        String runId = latest.getId();
        List<StageInstance> stages = stageInstanceRepo.findByRunIdOrderBySeqAsc(runId);

        int tablesTotal = stages.stream()
                .mapToInt(s -> s.getTablesTotal() == null ? 0 : s.getTablesTotal())
                .max().orElse(p.getTobeTableCount());

        // 적재 결과 = load stage 의 table 결과 (rows 합, success 수)
        long rows = 0;
        int tablesDone = 0;
        StageInstance load = stages.stream()
                .filter(s -> "load".equals(s.getStageKey()))
                .findFirst().orElse(null);
        if (load != null) {
            List<StageTableResult> results = stageTableResultRepo.findByStageInstanceIdIn(List.of(load.getId()));
            rows = results.stream().mapToLong(r -> r.getRowCount() == null ? 0 : r.getRowCount()).sum();
            tablesDone = (int) results.stream().filter(r -> r.getStatus() == StageTableStatus.success).count();
        }

        int progressPct;
        if (latest.getStatus() == RunStatus.success) {
            progressPct = 100;
        } else if (stages.isEmpty()) {
            progressPct = 0;
        } else {
            /* success は 1 段分の完全進捗、running は tablesSuccess/tablesTotal 割合の
               部分進捗として加算. failed は「結果が出た」けど 1 段ぶんとはみなさない
               (FE は失敗 stage を err として描画するので、失敗 stage を success と
               同列に数えると上の bar 数が増えて見える). */
            double progressed = 0;
            for (StageInstance s : stages) {
                if (s.getStatus() == StageStatus.success) {
                    progressed += 1.0;
                } else if (s.getStatus() == StageStatus.running) {
                    int total = s.getTablesTotal() == null ? 0 : s.getTablesTotal();
                    int ok = s.getTablesSuccess() == null ? 0 : s.getTablesSuccess();
                    if (total > 0) progressed += (double) ok / total;
                }
            }
            progressPct = (int) Math.round(100.0 * progressed / stages.size());
        }

        // FE 描画用 stage summary.
        List<StageSummary> stageSummaries = stages.stream()
                .map(ExecutionOverviewService::toSummary)
                .toList();

        long errorCount = quarantineRepo.countByRunIdAndSeverity(runId, QuarantineSeverity.error);
        // WARN entry 전체 + group 별 ack 매칭 → ackedCount = ack 된 group 의 entry 합.
        // KPI/그리드 "M/N 처리" 분수 표시용 (단위 = entry, group 단위 아님 — 기존 warningCount 와 통일).
        List<QuarantineEntry> warnEntries = quarantineRepo.findByRunIdOrderByCreatedAtAsc(runId).stream()
                .filter(q -> q.getSeverity() == QuarantineSeverity.warning)
                .toList();
        long warningCount = warnEntries.size();
        long warningAckedCount = 0;
        if (!warnEntries.isEmpty()) {
            java.util.Map<String, java.util.List<QuarantineEntry>> byGroup = new java.util.LinkedHashMap<>();
            for (QuarantineEntry q : warnEntries) {
                String reason = q.getSampleData() == null ? ""
                        : String.valueOf(q.getSampleData().getOrDefault("reason", ""));
                String key = q.getBindingId() + "|" + q.getRuleName() + "|" + reason;
                byGroup.computeIfAbsent(key, k -> new java.util.ArrayList<>()).add(q);
            }
            for (java.util.Map.Entry<String, java.util.List<QuarantineEntry>> e : byGroup.entrySet()) {
                QuarantineEntry sample = e.getValue().get(0);
                String reason = sample.getSampleData() == null ? ""
                        : String.valueOf(sample.getSampleData().getOrDefault("reason", ""));
                if (ackService.findExplicitAck(p.getId(), sample.getBindingId(),
                        sample.getRuleName(), reason, latest.getRunType()).isPresent()) {
                    warningAckedCount += e.getValue().size();
                }
            }
        }

        return new ProjectExecMetrics(p.getId(), p.getName(), runId, latest.getStatus().name(),
                rows, tablesTotal, tablesDone, errorCount, warningCount, warningAckedCount,
                progressPct, stageSummaries);
    }

    /**
     * StageInstance → StageSummary. pct は {@code StageController.derivePct} と同一式 —
     * Execution 画面 (/api/v1/runs/{id}/stages) と Overview 画面で同じ run / 同じ stage を
     * 見たときバーの幅が一致するように合わせる. 旧式は running 時に ok+failed を分子に
     * 含めていたが、success が分子の derivePct と桁が合わなかった (例: 5 中 3 success +
     * 1 failed → Execution 60% / Overview 80%).
     */
    private static StageSummary toSummary(StageInstance s) {
        int total = s.getTablesTotal() == null ? 0 : s.getTablesTotal();
        int ok = s.getTablesSuccess() == null ? 0 : s.getTablesSuccess();
        int failed = s.getTablesFailed() == null ? 0 : s.getTablesFailed();
        int pct = switch (s.getStatus()) {
            case pending -> 0;
            case success -> 100;
            case running, failed, failed_with_pending_warnings ->
                    total == 0 ? 0 : (int) Math.floor(100.0 * ok / total);
        };
        return new StageSummary(s.getStageKey(), s.getSeq(), s.getStatus().name(),
                Math.max(0, Math.min(100, pct)), total, ok, failed);
    }
}

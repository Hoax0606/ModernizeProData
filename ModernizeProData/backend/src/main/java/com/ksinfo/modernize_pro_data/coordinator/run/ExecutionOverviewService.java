package com.ksinfo.modernize_pro_data.coordinator.run;

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
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;

import java.util.List;

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
            int progressPct
    ) {}

    public List<ProjectExecMetrics> bySite(String siteId) {
        return projectRepo.findBySiteId(siteId).stream()
                .map(this::metricsFor)
                .toList();
    }

    private ProjectExecMetrics metricsFor(Project p) {
        RunHistory latest = runHistoryRepo.findFirstByProjectIdOrderByStartedAtDesc(p.getId());
        if (latest == null) {
            return new ProjectExecMetrics(p.getId(), p.getName(), null, null,
                    0, p.getTobeTableCount(), 0, 0, 0, 0);
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
            long done = stages.stream().filter(s -> s.getStatus() == StageStatus.success).count();
            progressPct = (int) (100 * done / stages.size());
        }

        long errorCount = quarantineRepo.countByRunIdAndSeverity(runId, QuarantineSeverity.error);
        long warningCount = quarantineRepo.countByRunIdAndSeverity(runId, QuarantineSeverity.warning);

        return new ProjectExecMetrics(p.getId(), p.getName(), runId, latest.getStatus().name(),
                rows, tablesTotal, tablesDone, errorCount, warningCount, progressPct);
    }
}

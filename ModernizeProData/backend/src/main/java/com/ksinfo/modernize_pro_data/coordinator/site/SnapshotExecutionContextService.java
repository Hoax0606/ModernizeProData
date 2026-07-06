package com.ksinfo.modernize_pro_data.coordinator.site;

import com.ksinfo.modernize_pro_data.coordinator.quarantine.QuarantineEntryRepository;
import com.ksinfo.modernize_pro_data.coordinator.quarantine.QuarantineSeverity;
import com.ksinfo.modernize_pro_data.coordinator.run.RunHistory;
import com.ksinfo.modernize_pro_data.coordinator.run.stage.StageInstance;
import com.ksinfo.modernize_pro_data.coordinator.run.stage.StageInstanceRepository;
import com.ksinfo.modernize_pro_data.coordinator.run.stage.StageTableResult;
import com.ksinfo.modernize_pro_data.coordinator.run.stage.StageTableResultRepository;
import com.ksinfo.modernize_pro_data.coordinator.site.frozen.SnapshotExecutionContext;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Duration;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.stream.Collectors;

/**
 * run 종료 시 snapshot 에 박제될 SnapshotExecutionContext 를 빌드해 저장.
 *
 * 호출 시점: {@code RunService.finishRun()} 의 RunHistory 저장 직후. terminal status
 * (success / failed / aborted / timed_out) 어느 경로든 한 번 호출되도록.
 *
 * 정책:
 *  - run.snapshotId 가 null 이면 (ad-hoc run — snapshot 없이 실행) 박제 X.
 *  - 같은 snapshot 으로 여러 번 run 하면 매 run 종료마다 덮어쓴다 (사용자 결정).
 *  - 박제 실패는 swallow + warn — run 종료 자체를 막지 않는다.
 */
@Service
@RequiredArgsConstructor
@Slf4j
public class SnapshotExecutionContextService {

    private final SnapshotRepository snapshotRepository;
    private final StageInstanceRepository stageInstanceRepository;
    private final StageTableResultRepository stageTableResultRepository;
    private final QuarantineEntryRepository quarantineEntryRepository;

    @Transactional
    public void recordExecutionContext(RunHistory rh) {
        if (rh == null || rh.getSnapshotId() == null) return;
        try {
            Optional<Snapshot> opt = snapshotRepository.findById(rh.getSnapshotId());
            if (opt.isEmpty()) {
                log.warn("Snapshot {} not found — execution_context freeze skipped (run {})",
                        rh.getSnapshotId(), rh.getId());
                return;
            }
            Snapshot snapshot = opt.get();

            // 1) 이 run 의 모든 stage_instance 를 seq 순으로.
            List<StageInstance> stages = stageInstanceRepository.findByRunIdOrderBySeqAsc(rh.getId());

            // 2) stage_table_results 를 한 번에 fetch + group by stage_instance_id.
            List<String> stageIds = stages.stream().map(StageInstance::getId).toList();
            Map<String, List<StageTableResult>> tablesByStage = stageIds.isEmpty()
                    ? Collections.emptyMap()
                    : stageTableResultRepository.findByStageInstanceIdIn(stageIds).stream()
                            .collect(Collectors.groupingBy(StageTableResult::getStageInstanceId));

            // 3) StageSnapshot + TableSnapshot 으로 변환.
            List<SnapshotExecutionContext.StageSnapshot> stageSnapshots = new ArrayList<>();
            for (StageInstance si : stages) {
                List<StageTableResult> tableResults = tablesByStage.getOrDefault(si.getId(), List.of());
                List<SnapshotExecutionContext.TableSnapshot> tableSnapshots = tableResults.stream()
                        .map(SnapshotExecutionContextService::toTableSnapshot)
                        .toList();
                stageSnapshots.add(new SnapshotExecutionContext.StageSnapshot(
                        si.getStageKey(),
                        si.getSeq() == null ? null : si.getSeq().intValue(),
                        si.getStatus() == null ? null : si.getStatus().name(),
                        derivePct(si),
                        si.getTablesTotal(),
                        si.getTablesSuccess(),
                        si.getTablesFailed(),
                        si.getStartedAt(),
                        si.getFinishedAt(),
                        si.getDurationMs(),
                        si.getErrorSummary(),
                        tableSnapshots
                ));
            }

            // 4) Top-level context.
            Long durationMs = rh.getDurationMs();
            if (durationMs == null && rh.getStartedAt() != null && rh.getFinishedAt() != null) {
                durationMs = Duration.between(rh.getStartedAt(), rh.getFinishedAt()).toMillis();
            }
            // Overview KPI (Errors/Warnings) 의 pinned 경로용 박제. live run 경로
            // (ExecutionOverviewService.metricsFor) 와 동일한 quarantineRepo.countByRunIdAndSeverity 를
            // 그 시점에 query 해 ctx 에 같이 freeze — pinned/non-pinned 사이의 KPI 정의 일관성.
            long errorCount = quarantineEntryRepository.countByRunIdAndSeverity(rh.getId(), QuarantineSeverity.error);
            long warningCount = quarantineEntryRepository.countByRunIdAndSeverity(rh.getId(), QuarantineSeverity.warning);

            SnapshotExecutionContext ctx = new SnapshotExecutionContext(
                    rh.getId(),
                    rh.getRunType() == null ? null : rh.getRunType().name(),
                    rh.getStatus() == null ? null : rh.getStatus().name(),
                    rh.getStartedAt(),
                    rh.getFinishedAt(),
                    durationMs,
                    stageSnapshots,
                    errorCount,
                    warningCount
            );
            snapshot.setExecutionContext(ctx);
            snapshotRepository.save(snapshot);
            log.info("Snapshot {} execution_context frozen from run {} (status={}, stages={})",
                    snapshot.getId(), rh.getId(), ctx.status(), stages.size());
        } catch (Exception e) {
            // 박제 실패가 run 종료 자체를 막으면 안 된다 — warn 만.
            log.warn("Failed to freeze execution_context for snapshot {} from run {}: {}",
                    rh.getSnapshotId(), rh.getId(), e.getMessage(), e);
        }
    }

    private static SnapshotExecutionContext.TableSnapshot toTableSnapshot(StageTableResult r) {
        return new SnapshotExecutionContext.TableSnapshot(
                r.getBindingId(),
                r.getTobeSchema(),
                r.getTobeTable(),
                r.getStatus() == null ? null : r.getStatus().name(),
                r.getRowCount(),
                r.getErrorCount(),
                r.getErrorDetail(),
                r.getStartedAt(),
                r.getFinishedAt(),
                r.getDurationMs(),
                r.getCompiledSql()
        );
    }

    /** {@code StageController.derivePct} 와 동일 로직 — read endpoint 와 박제 사이의 표시 일관성. */
    private static int derivePct(StageInstance si) {
        int total = si.getTablesTotal() == null ? 0 : si.getTablesTotal();
        int success = si.getTablesSuccess() == null ? 0 : si.getTablesSuccess();
        if (si.getStatus() == null) return 0;
        return switch (si.getStatus()) {
            case pending -> 0;
            case success -> 100;
            case running, failed, failed_with_pending_warnings ->
                    total == 0 ? 0 : (int) Math.floor(100.0 * success / total);
        };
    }
}

package com.ksinfo.modernize_pro_data.coordinator.api;

import com.ksinfo.modernize_pro_data.common.dto.ApiResponse;
import com.ksinfo.modernize_pro_data.coordinator.run.stage.StageInstance;
import com.ksinfo.modernize_pro_data.coordinator.run.stage.StageInstanceRepository;
import com.ksinfo.modernize_pro_data.coordinator.run.stage.StageStatus;
import com.ksinfo.modernize_pro_data.coordinator.run.stage.StageTableResult;
import com.ksinfo.modernize_pro_data.coordinator.run.stage.StageTableResultRepository;
import com.ksinfo.modernize_pro_data.coordinator.run.stage.StageTableStatus;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RestController;

import java.time.OffsetDateTime;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

/**
 * Run の stage 単位 進行情報を FE へ提供する read-only endpoint.
 *
 * Pipeline stages 영역 (frontend) 이 active run 中 2 秒 polling 하여 stage 별 진행률을 표시.
 * StageView 의 형태는 frontend `pipelineStages.ts` 의 `Stage` interface 와 1:1 매칭.
 */
@RestController
@RequiredArgsConstructor
public class StageController {

    private final StageInstanceRepository stageInstanceRepo;
    private final StageTableResultRepository stageTableResultRepo;

    public record StageView(
            String stageKey,
            int seq,
            StageStatus status,
            int pct,
            int tablesTotal,
            int tablesSuccess,
            int tablesFailed,
            OffsetDateTime startedAt,
            OffsetDateTime finishedAt,
            Long durationMs,
            String errorSummary,
            List<TableResultView> tables
    ) {}

    public record TableResultView(
            String bindingId,
            String tobeSchema,
            String tobeTable,
            StageTableStatus status,
            Long rowCount,
            Integer errorCount,
            Map<String, Object> errorDetail,
            OffsetDateTime startedAt,
            OffsetDateTime finishedAt,
            Long durationMs
    ) {}

    @GetMapping("/api/v1/runs/{runId}/stages")
    public ApiResponse<List<StageView>> listByRun(@PathVariable String runId) {
        List<StageInstance> stages = stageInstanceRepo.findByRunIdOrderBySeqAsc(runId);
        if (stages.isEmpty()) {
            return ApiResponse.ok(List.of());
        }

        // PoC 규모 (≤ 1.4k row/run) 라 1 query 로 table 전체를 가져와 stage 별 grouping.
        List<String> stageIds = stages.stream().map(StageInstance::getId).toList();
        Map<String, List<TableResultView>> tablesByStage = stageTableResultRepo
                .findByStageInstanceIdIn(stageIds)
                .stream()
                .collect(Collectors.groupingBy(
                        StageTableResult::getStageInstanceId,
                        Collectors.mapping(StageController::toTableView, Collectors.toList())));

        List<StageView> views = stages.stream()
                .map(si -> toStageView(si, tablesByStage.getOrDefault(si.getId(), List.of())))
                .toList();
        return ApiResponse.ok(views);
    }

    private static StageView toStageView(StageInstance si, List<TableResultView> tables) {
        return new StageView(
                si.getStageKey(),
                si.getSeq() == null ? 0 : si.getSeq().intValue(),
                si.getStatus(),
                derivePct(si),
                si.getTablesTotal() == null ? 0 : si.getTablesTotal(),
                si.getTablesSuccess() == null ? 0 : si.getTablesSuccess(),
                si.getTablesFailed() == null ? 0 : si.getTablesFailed(),
                si.getStartedAt(),
                si.getFinishedAt(),
                si.getDurationMs(),
                si.getErrorSummary(),
                tables
        );
    }

    private static TableResultView toTableView(StageTableResult str) {
        return new TableResultView(
                str.getBindingId(),
                str.getTobeSchema(),
                str.getTobeTable(),
                str.getStatus(),
                str.getRowCount(),
                str.getErrorCount(),
                str.getErrorDetail(),
                str.getStartedAt(),
                str.getFinishedAt(),
                str.getDurationMs()
        );
    }

    /**
     * pct derive — 저장하지 않고 매번 계산.
     *   pending → 0
     *   running → floor(100 * success / total) (total=0 시 0)
     *   success → 100
     *   failed  → floor(100 * success / total) — 부분 진행 표시
     */
    private static int derivePct(StageInstance si) {
        int total = si.getTablesTotal() == null ? 0 : si.getTablesTotal();
        int success = si.getTablesSuccess() == null ? 0 : si.getTablesSuccess();
        return switch (si.getStatus()) {
            case pending -> 0;
            case success -> 100;
            case running, failed -> total == 0 ? 0 : (int) Math.floor(100.0 * success / total);
        };
    }
}

package com.ksinfo.modernize_pro_data.coordinator.run;

import com.ksinfo.modernize_pro_data.coordinator.run.stage.StageInstance;
import com.ksinfo.modernize_pro_data.coordinator.run.stage.StageInstanceRepository;
import com.ksinfo.modernize_pro_data.coordinator.run.stage.StageTableResult;
import com.ksinfo.modernize_pro_data.coordinator.run.stage.StageTableResultRepository;
import com.ksinfo.modernize_pro_data.coordinator.run.stage.StageTableStatus;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Duration;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Collections;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

/**
 * Run History の drill-down 表示用 — 1 run の中の per-table (TO-BE 物理名単位) 集約結果.
 *
 * Run History 一覧では 1 run = 1 行で表示しつつ、行を展開すると per-table の status / rows /
 * duration / error が見えるようにするためのデータ提供.
 *
 * {@link StageTableResult} は (stage_instance × binding) の粒度なので、ここではそれを
 * tobe_table 単位に集約する:
 *   - status      : 1 つでも failed → "failed", 全 success → "success", それ以外 → "running"
 *   - rows        : Load stage の rowCount (= TO-BE に投入された実 row 数)
 *   - startedAt   : 当該 table を最初に処理した stage の startedAt (= min)
 *   - finishedAt  : 当該 table を最後に処理した stage の finishedAt (= max). 未完了なら null
 *   - durationMs  : wall-clock = finishedAt - startedAt. 「この table が最初の stage に
 *                   入ってから最後の stage を終えるまでに何 ms かかったか」.  各 stage の
 *                   durationMs の単純合計ではない — その間に他テーブルの処理時間も挟まる
 *                   ので合計は run-level duration と一致しないが、wall-clock per-table は
 *                   run-level duration と直接比較可能 (テーブルが run 全体のどこを占めて
 *                   いたかの目安).
 *
 * 注意: 表示用エラー情報はここでは返さない — Quarantine タブで個別に出している重複を避ける.
 */
@Service
@RequiredArgsConstructor
public class RunTableResultsService {

    private final StageInstanceRepository stageInstanceRepo;
    private final StageTableResultRepository stageTableResultRepo;

    /**
     * 1 run の per-table 結果一覧 (drill-down 展開時に取得).
     * tobe_table のアルファベット順で返す.
     */
    @Transactional(readOnly = true)
    public List<TableResultDto> resultsForRun(String runId) {
        List<StageInstance> stages = stageInstanceRepo.findByRunIdOrderBySeqAsc(runId);
        if (stages.isEmpty()) return List.of();
        Map<String, String> stageKeyById = stages.stream()
                .collect(Collectors.toMap(StageInstance::getId, StageInstance::getStageKey));
        List<String> stageIds = new ArrayList<>(stageKeyById.keySet());
        List<StageTableResult> results = stageTableResultRepo.findByStageInstanceIdIn(stageIds);
        if (results.isEmpty()) return List.of();

        // tobe_table 別 group.  qualified name (schema.table) でユニーク化.
        Map<String, List<StageTableResult>> byTable = results.stream()
                .collect(Collectors.groupingBy(
                        r -> qualified(r.getTobeSchema(), r.getTobeTable()),
                        LinkedHashMap::new,
                        Collectors.toList()));

        int totalStageCount = stages.size();
        List<TableResultDto> list = new ArrayList<>(byTable.size());
        for (Map.Entry<String, List<StageTableResult>> e : byTable.entrySet()) {
            List<StageTableResult> rs = e.getValue();
            StageTableResult first = rs.get(0);
            String tobeSchema = first.getTobeSchema() == null ? "" : first.getTobeSchema();
            String tobeTable = first.getTobeTable();

            boolean anyFailed = rs.stream().anyMatch(r -> r.getStatus() == StageTableStatus.failed);
            boolean allSuccess = rs.stream().allMatch(r -> r.getStatus() == StageTableStatus.success);
            /* "pending" — 처리된 stage 수가 전체보다 적고 failed 없음 + 처리된 것은 모두 success.
               abort 시 미실행 stage 가 있는 binding 이 단순 "success" 로 잘못 표시되던 케이스 해소.
               Pipeline 의 idle stage 와 의미적으로 일치 — FE 에서 idle tone (queued 라벨) 로 표시. */
            boolean allStagesProcessed = rs.size() >= totalStageCount;
            String status = anyFailed ? "failed"
                    : (allSuccess && allStagesProcessed) ? "success"
                    : allSuccess ? "pending"
                    : "running";

            // rows = Load stage の rowCount (TO-BE 投入数). 無ければ 0.
            long rows = 0;
            for (StageTableResult r : rs) {
                if ("load".equals(stageKeyById.get(r.getStageInstanceId())) && r.getRowCount() != null) {
                    rows = r.getRowCount();
                    break;
                }
            }

            /* per-table の startedAt / finishedAt / wall-clock duration を集約.
               startedAt = 全 stage 中の min(startedAt), finishedAt = max(finishedAt).
               durationMs = finishedAt - startedAt (wall-clock per table). 全 stage 完了して
               いなければ finishedAt = null, duration = null. */
            OffsetDateTime startedAt = rs.stream()
                    .map(StageTableResult::getStartedAt)
                    .filter(java.util.Objects::nonNull)
                    .min(OffsetDateTime::compareTo)
                    .orElse(null);
            boolean allFinished = rs.stream().allMatch(r -> r.getFinishedAt() != null);
            OffsetDateTime finishedAt = !allFinished ? null
                    : rs.stream()
                            .map(StageTableResult::getFinishedAt)
                            .max(OffsetDateTime::compareTo)
                            .orElse(null);
            Long durationMs = (startedAt != null && finishedAt != null)
                    ? Duration.between(startedAt, finishedAt).toMillis()
                    : null;

            list.add(new TableResultDto(tobeSchema, tobeTable, status, rows,
                    startedAt, finishedAt, durationMs));
        }
        // tobe_table アルファベット順 (qualified name で)
        list.sort((a, b) -> qualified(a.tobeSchema(), a.tobeTable()).compareToIgnoreCase(
                qualified(b.tobeSchema(), b.tobeTable())));
        return list;
    }

    /**
     * Run History 一覧用 — 複数 run の table summary (success/failed/running 件数) を一括取得.
     * N+1 を避けるため stage_instances → stage_table_results を 2 クエリで取って Java 集計.
     *
     * @return runId → TableSummary. 結果が空 (まだ stage_table_result が無い) run も summary を返す
     *         (success=0/failed=0/running=0).
     */
    @Transactional(readOnly = true)
    public Map<String, TableSummaryDto> summariesForRuns(Collection<String> runIds) {
        if (runIds == null || runIds.isEmpty()) return Map.of();
        List<StageInstance> stages = stageInstanceRepo.findByRunIdIn(runIds);
        if (stages.isEmpty()) {
            // どの run も stage 持ってない (新規 / 既に消えた) ので空 summary
            Map<String, TableSummaryDto> empty = new HashMap<>();
            for (String id : runIds) empty.put(id, TableSummaryDto.empty());
            return empty;
        }
        Map<String, String> runByStage = stages.stream()
                .collect(Collectors.toMap(StageInstance::getId, StageInstance::getRunId));

        List<StageTableResult> results = stageTableResultRepo.findByStageInstanceIdIn(runByStage.keySet());

        // runId → tobe_table (qualified) → results
        Map<String, Map<String, List<StageTableResult>>> grouped = results.stream()
                .filter(r -> runByStage.get(r.getStageInstanceId()) != null)
                .collect(Collectors.groupingBy(
                        r -> runByStage.get(r.getStageInstanceId()),
                        Collectors.groupingBy(
                                r -> qualified(r.getTobeSchema(), r.getTobeTable()))));

        // runId 별 전체 stage 수 (pending 판정에 필요).
        Map<String, Integer> stageCountByRun = new HashMap<>();
        for (StageInstance si : stages) {
            stageCountByRun.merge(si.getRunId(), 1, Integer::sum);
        }

        Map<String, TableSummaryDto> summaries = new HashMap<>();
        for (String runId : runIds) {
            Map<String, List<StageTableResult>> byTable = grouped.getOrDefault(runId, Collections.emptyMap());
            int totalStageCount = stageCountByRun.getOrDefault(runId, 0);
            int success = 0, failed = 0, running = 0, pending = 0;
            for (List<StageTableResult> rs : byTable.values()) {
                boolean anyFailed = rs.stream().anyMatch(r -> r.getStatus() == StageTableStatus.failed);
                boolean allSuccess = rs.stream().allMatch(r -> r.getStatus() == StageTableStatus.success);
                boolean allStagesProcessed = rs.size() >= totalStageCount;
                if (anyFailed) failed++;
                else if (allSuccess && allStagesProcessed) success++;
                else if (allSuccess) pending++;        // 처리된 stage 까진 OK 인데 후속 stage 미실행 (abort 등).
                else running++;
            }
            summaries.put(runId, new TableSummaryDto(success + failed + running + pending, success, failed, running, pending));
        }
        return summaries;
    }

    private static String qualified(String schema, String table) {
        if (schema == null || schema.isEmpty()) return table == null ? "" : table;
        return schema + "." + table;
    }

    /**
     * 1 run × 1 tobe_table の集約結果 (drill-down 行).
     *
     * @param tobeSchema    TO-BE スキーマ. 無ければ空文字
     * @param tobeTable     TO-BE 物理名
     * @param status        success / failed / running
     * @param rows          Load stage の投入 row 数. 0 = 未取得 / Load 未到達
     * @param startedAt     当該 table を最初に処理した stage の startedAt. 全 stage 未開始なら null
     * @param finishedAt    当該 table を最後に処理した stage の finishedAt. 未完了なら null
     * @param durationMs    wall-clock per table = finishedAt - startedAt. 未完了なら null
     */
    public record TableResultDto(
            String tobeSchema,
            String tobeTable,
            String status,
            long rows,
            OffsetDateTime startedAt,
            OffsetDateTime finishedAt,
            Long durationMs
    ) {}

    /**
     * Run History 一覧用 — 1 run の table 別件数サマリ. 0/0/0/0 = まだ table 処理が始まっていない.
     *
     * @param total    集約された tobe_table 数 (= 当該 run が処理した binding 数)
     * @param success  全 stage success の table 数
     * @param failed   1 つでも failed のあった table 数
     * @param running  実行中 (一部 stage 残, 一部 result 未完了)
     * @param pending  処理された stage は success だが後続 stage 未実行 (abort 等). Pipeline の idle 相当.
     */
    public record TableSummaryDto(int total, int success, int failed, int running, int pending) {
        public static TableSummaryDto empty() { return new TableSummaryDto(0, 0, 0, 0, 0); }
    }
}

package com.ksinfo.modernize_pro_data.coordinator.run;

import com.ksinfo.modernize_pro_data.coordinator.ddl.DdlImportService;
import com.ksinfo.modernize_pro_data.coordinator.ddl.DdlTable;
import com.ksinfo.modernize_pro_data.coordinator.ddl.DdlTableRepository;
import com.ksinfo.modernize_pro_data.coordinator.run.stage.StageInstance;
import com.ksinfo.modernize_pro_data.coordinator.run.stage.StageInstanceRepository;
import com.ksinfo.modernize_pro_data.coordinator.run.stage.StageTableResult;
import com.ksinfo.modernize_pro_data.coordinator.run.stage.StageTableResultRepository;
import com.ksinfo.modernize_pro_data.coordinator.run.stage.StageTableStatus;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.stream.Collectors;

/**
 * project 単位の「Request Review ゲート」判定材料を返す read-only サービス.
 *
 * 旧仕様: Execution 画面でその snapshot に対して preflight を完了し、かつ全 TO-BE
 * テーブルが pass している場合のみ Request Review 可能だった (snapshot 別 cache).
 *
 * 新仕様 (2026-05-28): preflight pass ではなく「project の全 TO-BE テーブルの最新
 * RUN が success」であることを条件にする.
 *
 * 判定粒度 (2026-05-29 改): run-level status ではなく {@code stage_table_results}
 * の per-binding 実結果を見る. 理由は scheduler / bulk run が tables=null で起動して
 * run.status=failed になった場合、その run 内で実際は success だった他テーブルまで
 * 「failed」扱いになって再実行を強要してしまうため. binding 単位で評価すれば、
 * 同じ scheduler run の中で「table A/B = success, table C = failed」と分けて
 * 認識できる.
 *
 * 判定ロジック:
 *   1. project の TO-BE DDL から物理名集合 T を取る. 空なら readiness=false (DDL 未取込).
 *   2. project の terminal run を新しい順に走査 (pending/running/paused は除外).
 *   3. 各 run について {@link StageTableResult} を集め, tobe_table 別に集約:
 *      - 該当 tobe_table の全 stage 結果が success → SUCCESS
 *      - 1 つでも failed → FAILED
 *      - それ以外 (running 残り等) → INCOMPLETE (=ゲート的には failed と同じく不可)
 *   4. tobe_table 毎に「最初に決まった状態 (= 一番新しい run の結果)」を採用. 後続の
 *      古い run はその table については skip.
 *   5. 全 TO-BE table が SUCCESS なら allReady=true.
 *
 * 注意:
 *   - tobe_table は denormalize されているので binding テーブル join 不要.
 *   - 「table T が一度も run に含まれていない」場合は notRun に分類.
 *   - 「table T が run に含まれていたが、run abort/timeout で StageTableResult が
 *     作られなかった」場合も notRun として扱われる (同じく再実行が必要).
 */
@Service
@RequiredArgsConstructor
public class ProjectRunReadinessService {

    private final DdlTableRepository ddlTableRepo;
    private final RunHistoryRepository runHistoryRepo;
    private final StageInstanceRepository stageInstanceRepo;
    private final StageTableResultRepository stageTableResultRepo;

    /**
     * Per-project の Request Review readiness.
     *
     * @param projectId 対象 project
     * @return 全テーブル分の集計結果 DTO. project に TO-BE DDL が無ければ allReady=false +
     *         totalTables=0 で返す (FE 側で「DDL 未取込」表示).
     */
    @Transactional(readOnly = true)
    public ProjectRunReadinessDto readinessFor(String projectId) {
        List<DdlTable> tobeTables = ddlTableRepo.findByProjectIdAndSideOrderByOrdinalAsc(
                projectId, DdlImportService.SIDE_TOBE);
        if (tobeTables.isEmpty()) {
            return new ProjectRunReadinessDto(false, 0, 0, List.of(), List.of());
        }

        Set<String> tobeNames = new HashSet<>();
        List<String> orderedNames = new ArrayList<>(tobeTables.size());
        for (DdlTable t : tobeTables) {
            String n = t.getPhysicalName();
            if (n != null && tobeNames.add(n)) {
                orderedNames.add(n);
            }
        }

        // terminal run を新しい順. paused/running はまだ結果が出ていないので除外.
        List<RunHistory> terminalRuns = runHistoryRepo
                .findByProjectIdOrderByStartedAtDesc(projectId).stream()
                .filter(r -> isTerminal(r.getStatus()))
                .toList();

        // テーブル毎の最新確定状態. 新しい run から走査 + putIfAbsent で「latest = 真」.
        Map<String, TableState> latestPerTable = new LinkedHashMap<>();

        for (RunHistory run : terminalRuns) {
            if (latestPerTable.size() == tobeNames.size()) break;

            List<StageInstance> stages = stageInstanceRepo.findByRunIdOrderBySeqAsc(run.getId());
            if (stages.isEmpty()) continue;
            List<String> stageIds = stages.stream().map(StageInstance::getId).toList();
            List<StageTableResult> results = stageTableResultRepo.findByStageInstanceIdIn(stageIds);
            if (results.isEmpty()) continue;

            // tobe_table 別に集約.  DDL の TO-BE table 集合に居ないものは無視 (renamed 残骸).
            Map<String, List<StageTableResult>> byTable = results.stream()
                    .filter(r -> r.getTobeTable() != null && tobeNames.contains(r.getTobeTable()))
                    .collect(Collectors.groupingBy(StageTableResult::getTobeTable));

            for (Map.Entry<String, List<StageTableResult>> e : byTable.entrySet()) {
                String tobeTable = e.getKey();
                if (latestPerTable.containsKey(tobeTable)) continue;  // newer run が既に決定済

                List<StageTableResult> rs = e.getValue();
                // 2026-06-01 WARN ack 시스템: failed_with_pending_warnings 도 차단.
                // 운영자 ack 후 다음 run 에서 success → 그때 readiness 통과.
                boolean anyFailed = rs.stream().anyMatch(r ->
                        r.getStatus() == StageTableStatus.failed
                        || r.getStatus() == StageTableStatus.failed_with_pending_warnings);
                boolean allSuccess = rs.stream().allMatch(r -> r.getStatus() == StageTableStatus.success);
                TableState state;
                if (anyFailed)        state = TableState.FAILED;
                else if (allSuccess)  state = TableState.SUCCESS;
                else                  state = TableState.INCOMPLETE;
                latestPerTable.put(tobeTable, state);
            }
        }

        List<String> failed = new ArrayList<>();
        List<String> notRun = new ArrayList<>();
        int success = 0;
        for (String t : orderedNames) {
            TableState state = latestPerTable.get(t);
            if (state == null) notRun.add(t);
            else if (state == TableState.SUCCESS) success++;
            else failed.add(t);   // FAILED + INCOMPLETE はゲート的に failed と同列
        }
        boolean allReady = success == orderedNames.size();
        return new ProjectRunReadinessDto(allReady, orderedNames.size(), success, notRun, failed);
    }

    /** 最新 run での per-table 集約結果. */
    private enum TableState { SUCCESS, FAILED, INCOMPLETE }

    /** Terminal = 結果が確定した run. pending/running/paused は除外. */
    private static boolean isTerminal(RunStatus s) {
        return s == RunStatus.success
                || s == RunStatus.failed
                || s == RunStatus.aborted
                || s == RunStatus.timed_out;
    }

    /**
     * Request Review ゲート用 DTO.
     *
     * @param allReady        全 TO-BE テーブルで最新 run 結果 = success の時のみ true
     * @param totalTables     project の TO-BE テーブル数
     * @param completedTables 最新 run で全 stage success だった TO-BE テーブル数
     * @param notRunTables    そもそも StageTableResult が一度も書かれていない TO-BE テーブル名
     * @param failedTables    最新 run の stage_table_results が failed / incomplete だった TO-BE テーブル名
     */
    public record ProjectRunReadinessDto(
            boolean allReady,
            int totalTables,
            int completedTables,
            List<String> notRunTables,
            List<String> failedTables
    ) {}
}

package com.ksinfo.modernize_pro_data.coordinator.run;

import com.ksinfo.modernize_pro_data.coordinator.site.ProjectRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Component;

import java.util.List;

/**
 * Coordinator 起動 시 run 상태 reconcile — 직전 process 가 비정상 종료(OOM/crash)되면
 * {@code RunService.finishRun} 의 종료 처리가 안 돌아 run/project 상태가 'running' 으로
 * 박제된다. 그 결과 Execution Overview 의 phase 배지가 멈췄는데도 running(주황)으로 남고,
 * project 가 idle 로 안 풀려 다음 run 이 lock 으로 거부된다.
 *
 * <p>처리:
 * <ol>
 *   <li>起動 시점에 {@code running}/{@code pending} 으로 남은 run 을 abort.
 *       coordinator in-process executor thread 는 재시작으로 모두 소멸했고, remote worker
 *       run 이라도 coordination 이 끊긴 run 은 신뢰하지 않고 재실행하는 것이 데이터 이행
 *       도구로서 안전하다. {@code abortRun} → {@code finishRun} 이 projects.run_status 를
 *       idle 로 되돌리고 audit/snapshot 박제까지 cascade 한다. worker 가 online 이면
 *       RUN_CANCEL 도 함께 전달된다 (offline 이면 no-op).</li>
 *   <li>run_history 는 이미 terminal 인데 projects.run_status 만 'running' 으로 남은
 *       orphan flag (한쪽만 갱신된 경우 / 외부 수동 개입)를 idle 로 복귀. 실제 running
 *       run 이 없는 project 에만 적용 — 살아있을 수 있는 run 은 1단계가 처리한다.</li>
 * </ol>
 *
 * <p>{@code RunTimeoutSweeper}(180분 hung-run sweep)는 <em>살아있는</em> coordinator 가
 * 오래 매달린 run 을 정리하는 용도이고, 본 reconciler 는 <em>재시작 직후</em> 1회 정리라
 * 역할이 겹치지 않는다.
 */
@Component
@RequiredArgsConstructor
@Slf4j
public class RunStartupReconciler {

    private final RunHistoryRepository runRepo;
    private final RunService runService;
    private final ProjectRepository projectRepo;

    @EventListener(ApplicationReadyEvent.class)
    public void reconcileOnStartup() {
        // 1. 起動 시점 in-flight (running/pending) run = 직전 process 와 함께 중단된 orphan.
        List<RunHistory> inflight = runRepo.findByStatusIn(List.of(RunStatus.running, RunStatus.pending));
        int aborted = 0;
        for (RunHistory rh : inflight) {
            try {
                // abortRun 은 自身이 @Transactional — 각 run 을 독립 tx 로 정리해 한 건 실패가
                // 나머지를 막지 않게 한다.
                runService.abortRun(rh.getId(), "coordinator restarted — run interrupted");
                aborted++;
            } catch (Exception e) {
                log.warn("Startup reconcile: abort failed runId={}: {}", rh.getId(), e.getMessage());
            }
        }

        // 2. run_history 는 terminal 인데 project flag 만 'running' 으로 박제된 orphan 정리.
        int reset = projectRepo.resetOrphanRunningStatus(RunStatus.running);

        if (aborted > 0 || reset > 0) {
            log.warn("Startup reconcile done — aborted {} interrupted run(s), reset {} orphan project run_status to idle.",
                    aborted, reset);
        } else {
            log.info("Startup reconcile — no orphaned runs or stale project run_status.");
        }
    }
}

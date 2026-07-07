package com.ksinfo.modernize_pro_data.coordinator.run;

import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

import java.time.OffsetDateTime;
import java.util.List;

/**
 * 타임아웃 sweep — running 상태가 임계(기본 180분)를 넘긴 run 을 자동으로 timed_out 종료.
 *
 * 목적: hung/stuck run (thread 멈춤, 콜백 누락 등)이 영영 running 으로 남아 project 잠금이
 * 안 풀리는 상황 방지. 정상 대용량 run 을 끊지 않도록 임계는 넉넉히 + 설정 가능.
 *
 * @Scheduled — @EnableScheduling 은 ModernizeProDataApplication 에 이미 있음.
 */
@Component
@RequiredArgsConstructor
@Slf4j
public class RunTimeoutSweeper {

    /** running 이 이 분(minute) 을 넘기면 timed_out. */
    @Value("${modernize.run.timeout-minutes:180}")
    private long timeoutMinutes;

    private final RunHistoryRepository runRepo;
    private final RunService runService;

    /** sweep 주기 (ms). 기본 60초. */
    @Scheduled(fixedDelayString = "${modernize.run.timeout-sweep-ms:60000}")
    public void sweep() {
        OffsetDateTime cutoff = OffsetDateTime.now().minusMinutes(timeoutMinutes);
        List<RunHistory> stuck = runRepo.findByStatusAndStartedAtBefore(RunStatus.running, cutoff);
        if (stuck.isEmpty()) return;
        for (RunHistory rh : stuck) {
            try {
                runService.timeoutRun(rh.getId(),
                        "exceeded max execution time (" + timeoutMinutes + "m)");
                log.warn("Run timed out runId={} startedAt={}", rh.getId(), rh.getStartedAt());
            } catch (Exception e) {
                log.warn("timeoutRun failed runId={}: {}", rh.getId(), e.getMessage());
            }
        }
    }
}

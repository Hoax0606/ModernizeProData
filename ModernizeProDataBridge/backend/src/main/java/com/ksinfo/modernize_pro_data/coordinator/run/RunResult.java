package com.ksinfo.modernize_pro_data.coordinator.run;

/**
 * RunService.startRun() 의 戻り値.
 *
 * - status = STARTED  : runId 가 발급되어 Worker dispatch 까지 완료
 * - status = REJECTED : validation 失敗 (project not found / phase 不一致 / snapshot 未承認 等). reason 必須
 * - status = LOCKED   : 二重起動 (이미 run 중). reason 必須
 *
 * jobExecutionId 는 PoC 1 차 시점에서 Worker 가 ACK 後 별도 update.
 * 즉시 return 時점에서는 NULL.
 */
public record RunResult(
        String runId,
        RunStartStatus status,
        Long jobExecutionId,
        String reason
) {
    public static RunResult started(String runId) {
        return new RunResult(runId, RunStartStatus.STARTED, null, null);
    }

    public static RunResult rejected(String reason) {
        return new RunResult(null, RunStartStatus.REJECTED, null, reason);
    }

    public static RunResult locked(String reason) {
        return new RunResult(null, RunStartStatus.LOCKED, null, reason);
    }
}

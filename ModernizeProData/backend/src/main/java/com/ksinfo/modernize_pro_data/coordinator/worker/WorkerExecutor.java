package com.ksinfo.modernize_pro_data.coordinator.worker;

/**
 * Stage 실행 strategy interface.
 *
 * PoC 1차: LocalWorkerExecutor (Coordinator 내장, sequential in-process).
 * 추후: 분산 worker 가 들어오면 RemoteWorkerExecutor 추가, RunService 에서 config 로 분기.
 */
public interface WorkerExecutor {
    void execute(StageContext ctx);
}

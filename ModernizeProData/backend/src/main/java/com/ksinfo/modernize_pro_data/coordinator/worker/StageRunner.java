package com.ksinfo.modernize_pro_data.coordinator.worker;

import com.ksinfo.modernize_pro_data.coordinator.run.stage.StageInstance;

/**
 * 한 stage 의 실행 strategy. Spring `@Service` bean 으로 등록되고,
 * LocalWorkerExecutor 가 stageKey() 기준으로 dispatch.
 */
public interface StageRunner {

    /** check / extract / reconcile / transform / audit / load / verify */
    String stageKey();

    /**
     * Stage 실행. RunService.startStage / completeStage / recordTableResult 는
     * 구현체 안에서 호출. Continue-on-error 모델 — exception 던지지 않고
     * stage 안에서 table fail 처리 + completeStage(tablesFailed>0).
     */
    void run(StageContext ctx, StageInstance stage);
}

package com.ksinfo.modernize_pro_data.coordinator.worker;

/**
 * Stage runner 가 cancel 신호를 감지했을 때 던지는 예외.
 *
 * 사용자가 정지 누르거나 timeout sweep 발동 시 RunControlRegistry.cancel(runId) 으로
 * 신호 set. Stage runner 가 table loop 마다 ctx.throwIfCancelled() 로 체크해서
 * 이 예외를 던지면, LocalWorkerExecutor 가 현재 stage 의 status 를 failed 로 마킹.
 *
 * 일반 Exception (= 시스템 에러로 인한 실패) 와 구별하기 위해 별도 type.
 * 그래야 LocalWorkerExecutor 가 "사용자 의도된 중단" vs "비정상 에러" 를 분리해 처리.
 */
public class RunCancelledException extends RuntimeException {
    public RunCancelledException(String message) {
        super(message);
    }
}

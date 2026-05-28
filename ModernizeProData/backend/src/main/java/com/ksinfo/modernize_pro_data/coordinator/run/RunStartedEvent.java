package com.ksinfo.modernize_pro_data.coordinator.run;

/**
 * RunService.startRun 의 transaction commit 후 발행되는 event.
 * RunExecutionListener 가 받아 별 thread 에서 StageContext build + 7-stage 실행.
 */
public record RunStartedEvent(String runId, String projectId) {}

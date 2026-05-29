package com.ksinfo.modernize_pro_data.coordinator.run.stage;

/**
 * stage_table_results.status — stage 안 1 테이블 처리 결과.
 * lazy insert 이므로 pending 없음.
 */
public enum StageTableStatus {
    running,
    success,
    failed
}

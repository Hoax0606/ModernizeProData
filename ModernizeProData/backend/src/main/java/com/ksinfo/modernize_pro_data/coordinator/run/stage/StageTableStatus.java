package com.ksinfo.modernize_pro_data.coordinator.run.stage;

/**
 * stage_table_results.status — stage 안 1 테이블 처리 결과.
 * lazy insert 이므로 pending 없음.
 * failed_with_pending_warnings: WARN 만 있고 운영자 ack 미존재 — per-binding readiness 차단.
 *   기존 failed 유지 (위험 1 회귀 대응 — 새 상태 별도 추가).
 */
public enum StageTableStatus {
    running,
    success,
    failed,
    failed_with_pending_warnings
}

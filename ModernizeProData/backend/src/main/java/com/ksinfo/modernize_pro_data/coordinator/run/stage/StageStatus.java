package com.ksinfo.modernize_pro_data.coordinator.run.stage;

/**
 * stage_instances.status — stage 1 회분의 상태.
 * pending: pre-create 직후 / running: 첫 table dispatch / success / failed (continue-on-error 모델).
 * failed_with_pending_warnings: WARN 만 있고 운영자 ack 미존재 — Request Review 게이트 차단.
 *   기존 failed 유지 (위험 1 회귀 대응 — 새 상태 별도 추가).
 */
public enum StageStatus {
    pending,
    running,
    success,
    failed,
    failed_with_pending_warnings
}

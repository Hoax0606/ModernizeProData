package com.ksinfo.modernize_pro_data.coordinator.run.stage;

/**
 * stage_instances.status — stage 1 회분의 상태.
 * pending: pre-create 직후 / running: 첫 table dispatch / success / failed (continue-on-error 모델).
 */
public enum StageStatus {
    pending,
    running,
    success,
    failed
}

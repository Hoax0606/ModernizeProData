package com.ksinfo.modernize_pro_data.coordinator.run;

/**
 * run_history.status — run 1 회분의 詳細 status.
 * projects.run_status (3 値: idle/running/completed) 는 UI 表示用、
 * RunStatus 는 監査 / 분석용 完全履歴.
 *
 * 2026-05-29: paused 제거. Stop + Retry (resume-from-failed-stage) 가 기능 동치라 UI 단순화.
 */
public enum RunStatus {
    pending,
    running,
    success,
    failed,
    aborted,
    timed_out
}

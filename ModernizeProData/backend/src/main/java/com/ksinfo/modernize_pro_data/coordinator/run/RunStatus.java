package com.ksinfo.modernize_pro_data.coordinator.run;

/**
 * run_history.status — run 1 회분의 詳細 status (6 値).
 * projects.run_status (3 値: idle/running/completed) 는 UI 表示用、
 * RunStatus 는 監査 / 분석용 完全履歴.
 */
public enum RunStatus {
    pending,
    running,
    paused,
    success,
    failed,
    aborted,
    timed_out
}

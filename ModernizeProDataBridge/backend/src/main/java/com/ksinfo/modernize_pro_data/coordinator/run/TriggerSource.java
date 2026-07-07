package com.ksinfo.modernize_pro_data.coordinator.run;

/**
 * Run 起動経路.
 * - internal  : Quartz Nightly Rehearsal Job 발화 (元 nightly)
 * - cli       : modernize-cli 바이너리에서 호출
 * - external  : 외부스케줄러로부터 REST POST /api/v1/runs (元 rest)
 * - manual    : UI 의 Run 버튼 (元 manual_ui)
 *
 * Run service 의 동작에는 영향を 주지 않음. run_history 監査用.
 */
public enum TriggerSource {
    internal,
    cli,
    external,
    manual
}

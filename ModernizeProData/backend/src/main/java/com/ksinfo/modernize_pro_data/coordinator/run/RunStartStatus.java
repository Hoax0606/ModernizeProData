package com.ksinfo.modernize_pro_data.coordinator.run;

/**
 * RunService.startRun() の戻り値 status.
 * - STARTED  : run が無事に開始された
 * - REJECTED : validation 失敗 (phase 不一致 / snapshot 未承認 / 環境不一致 等)
 * - LOCKED   : 既に別 run が走っているため二重起動を拒否
 *
 * DB 永続化対象ではない (RunService の return 用).
 */
public enum RunStartStatus {
    STARTED,
    REJECTED,
    LOCKED
}

package com.ksinfo.modernize_pro_data.coordinator.run.delta;

/** CDC 델타 파이프라인 공용 상수. */
public final class DeltaConstants {

    private DeltaConstants() {}

    /**
     * 델타 CSV·파이프라인의 op-type 제어 컬럼명. 값 = {@code I}/{@code U}/{@code D}.
     * Extract 가 asis_ 로 그대로 싣고, Transform 이 tobe_ 로 passthrough 하며,
     * Load(merge) 가 이 컬럼으로 upsert/delete 를 분기한다. <b>타깃 본테이블엔 적재하지 않는다.</b>
     */
    public static final String OP_COLUMN = "__op";

    /**
     * 델타 CSV 의 <b>선택</b> SCN 컬럼명 (Oracle System Change Number). 있으면 병합 후
     * {@code delta_watermark.last_applied_scn} 로 최대값을 기록(감사·재개 커서). 없으면 무시.
     * 타깃 본테이블엔 적재하지 않는다.
     */
    public static final String SCN_COLUMN = "__scn";
}

package com.ksinfo.modernize_pro_data.coordinator.run.stage;

import com.ksinfo.modernize_pro_data.coordinator.run.RunType;

import java.util.List;

/**
 * RunType 별 실행되는 stage 순서.
 * Sprint 0 결정 (2026-05-25): cutover 는 Audit 를 빼고 6 stage.
 */
public final class StageCatalog {

    public static final List<String> TEST_STAGES = List.of(
            "check", "extract", "reconcile", "transform", "audit", "load", "verify");

    public static final List<String> CUTOVER_STAGES = List.of(
            "check", "extract", "reconcile", "transform", "load", "verify");

    private StageCatalog() {}

    public static List<String> forRunType(RunType runType) {
        return runType == RunType.cutover ? CUTOVER_STAGES : TEST_STAGES;
    }
}

package com.ksinfo.modernize_pro_data.coordinator.run.stage;

import com.ksinfo.modernize_pro_data.coordinator.run.RunType;

import java.util.List;

/**
 * RunType 별 실행되는 stage 순서.
 * Sprint 0 결정 (2026-05-25): cutover 는 Audit 를 빼고 6 stage.
 * 2026-05-30: 'validation' 추가 (8 번째). Verify 직후 aggregate 검증 보고서 생성 — 일본 금융권
 * 감사 증빙물. test/rehearsal/cutover 모두 적용 (cutover 도 SUM 일치 증빙 필요).
 */
public final class StageCatalog {

    public static final List<String> TEST_STAGES = List.of(
            "check", "extract", "reconcile", "transform", "audit", "load", "verify", "validation");

    public static final List<String> CUTOVER_STAGES = List.of(
            "check", "extract", "reconcile", "transform", "load", "verify", "validation");

    private StageCatalog() {}

    public static List<String> forRunType(RunType runType) {
        return runType == RunType.cutover ? CUTOVER_STAGES : TEST_STAGES;
    }
}

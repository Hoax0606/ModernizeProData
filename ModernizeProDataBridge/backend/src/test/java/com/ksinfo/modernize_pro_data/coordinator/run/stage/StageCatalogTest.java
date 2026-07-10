package com.ksinfo.modernize_pro_data.coordinator.run.stage;

import com.ksinfo.modernize_pro_data.coordinator.run.RunType;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * StageCatalog — RunType 별 stage 목록 계약 (핸드오프 Task D).
 *
 * 확인 사항:
 *   - cutover run 에 reconcile / verify / validation 이 실제로 포함된다 (적재 후 정합 검증 보장).
 *   - cutover 는 audit 를 <b>의도적으로 제외</b>한다 (Sprint 0 결정 2026-05-25). test/rehearsal 만 audit 포함.
 *   - 이 목록이 RunService 의 stage 인스턴스 사전생성을 그대로 좌우하므로 순서/구성을 회귀 고정.
 */
class StageCatalogTest {

    @Test
    void cutover_includesReconcileVerifyValidation() {
        List<String> cutover = StageCatalog.forRunType(RunType.cutover);
        assertThat(cutover).contains("reconcile", "verify", "validation");
    }

    @Test
    void cutover_excludesAudit_byDesign() {
        assertThat(StageCatalog.CUTOVER_STAGES).doesNotContain("audit");
    }

    @Test
    void testAndRehearsal_includeAudit() {
        assertThat(StageCatalog.forRunType(RunType.test)).contains("audit");
        assertThat(StageCatalog.forRunType(RunType.rehearsal)).contains("audit");
    }

    @Test
    void exactCatalogs_lockedForRegression() {
        assertThat(StageCatalog.TEST_STAGES).containsExactly(
                "check", "extract", "reconcile", "transform", "audit", "load", "verify", "validation");
        assertThat(StageCatalog.CUTOVER_STAGES).containsExactly(
                "check", "extract", "reconcile", "transform", "load", "verify", "validation");
    }

    @Test
    void cutoverIsTestMinusAudit_sameRelativeOrder() {
        // cutover 는 test 순서에서 audit 만 뺀 것과 동일해야 한다.
        List<String> testMinusAudit = new ArrayList<>(StageCatalog.TEST_STAGES);
        testMinusAudit.remove("audit");
        assertThat(StageCatalog.CUTOVER_STAGES).containsExactlyElementsOf(testMinusAudit);
    }

    @Test
    void forRunType_maps_testAndRehearsalToTest_cutoverToCutover() {
        assertThat(StageCatalog.forRunType(RunType.test)).isEqualTo(StageCatalog.TEST_STAGES);
        assertThat(StageCatalog.forRunType(RunType.rehearsal)).isEqualTo(StageCatalog.TEST_STAGES);
        assertThat(StageCatalog.forRunType(RunType.cutover)).isEqualTo(StageCatalog.CUTOVER_STAGES);
    }

    @Test
    void orderingInvariants_extractTransformLoadVerifyValidation() {
        for (RunType rt : RunType.values()) {
            List<String> s = StageCatalog.forRunType(rt);
            assertThat(s.indexOf("extract")).as(rt + ": extract<transform").isLessThan(s.indexOf("transform"));
            assertThat(s.indexOf("transform")).as(rt + ": transform<load").isLessThan(s.indexOf("load"));
            assertThat(s.indexOf("load")).as(rt + ": load<verify").isLessThan(s.indexOf("verify"));
            assertThat(s.indexOf("verify")).as(rt + ": verify<validation").isLessThan(s.indexOf("validation"));
            assertThat(s.indexOf("reconcile")).as(rt + ": reconcile<transform").isLessThan(s.indexOf("transform"));
            // validation 은 항상 마지막
            assertThat(s.get(s.size() - 1)).as(rt + ": validation last").isEqualTo("validation");
        }
    }

    @Test
    void noDuplicateStages() {
        for (RunType rt : RunType.values()) {
            List<String> s = StageCatalog.forRunType(rt);
            assertThat(s).as(rt + " no dupes").doesNotHaveDuplicates();
        }
    }
}

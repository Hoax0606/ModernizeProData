package com.ksinfo.modernize_pro_data.coordinator.site.frozen;

import java.util.List;

public record SnapshotData(
        List<FrozenRule> rules,
        List<FrozenCodeMap> codeMaps,
        List<FrozenBinding> bindings,
        List<FrozenAsisSkip> asisSkips
) {
    /** legacy snapshot JSONB 가 asisSkips 누락 → null. 호출 측에서 안전한 빈 list 로 normalize. */
    public List<FrozenAsisSkip> asisSkips() {
        return asisSkips == null ? List.of() : asisSkips;
    }
}
